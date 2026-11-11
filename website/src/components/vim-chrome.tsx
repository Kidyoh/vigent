"use client";

import { useEffect, useRef, useState } from "react";
import { INSTALL, REPO } from "../lib/site";
import { SitePicker } from "./site-picker";

/** Where `:<command>` goes. */
const ROUTES: Record<string, string> = {
  install: "/#install",
  engines: "/#engines",
  keys: "/#keys",
  themes: "/#themes",
  top: "/",
  home: "/",
  riftri: "/docs#riftri",
  worktrees: "/docs#worktrees",
  engine: "/docs#engines",
  merge: "/docs#review",
  diff: "/docs#review",
  model: "/docs#model",
  effort: "/docs#model",
  config: "/docs#config",
  settings: "/docs#config",
  docs: "/docs",
  help: "/docs",
  h: "/docs",
};

/** The buffer's lines, in order (not the ~ past the end). */
const lines = () => Array.from(document.querySelectorAll<HTMLElement>("main.buffer .l:not(.tilde)"));

/** What `yy` copies from a line: the install command on its line, a code block whole, otherwise the line's text. */
function lineText(el: HTMLElement): string {
  if (el.querySelector("[data-yank], .install")) return INSTALL;
  const pre = el.querySelector("pre");
  if (pre) return (pre.textContent ?? "").replace(/\s+$/, "");
  const t = el.querySelector<HTMLElement>(".t") ?? el;
  return t.innerText.replace(/\s+/g, " ").trim();
}

/** What Enter does on a line, if anything (shown when the cursor gets there). */
function enterHint(el: HTMLElement): string | undefined {
  if (el.querySelector("[data-colorscheme]")) return "Enter: pick a colorscheme (j/k preview each one, Enter keeps it, q goes back)";
  if (el.querySelector("[data-yank], .install")) return "Enter or yy: copy the install command";
  const a = el.querySelector("a[href]");
  if (a) return `Enter: open ${a.textContent?.trim() || "the link"}`;
  return undefined;
}

/** smartcase, as in LazyVim: case-insensitive unless the search has a capital */
const fold = (term: string, text: string) => (/[A-Z]/.test(term) ? text : text.toLowerCase());
/** a line's text as the search sees it */
const textOf = (el: HTMLElement) => (el.innerText || el.textContent || "").replace(/\s+/g, " ");

/**
 * Highlight every match of `term` in the buffer (hlsearch): lines with a
 * match get .match, and the text itself a CSS highlight where the browser has them.
 */
function paintMatches(term?: string) {
  const all = lines();
  all.forEach((l) => l.classList.toggle("match", !!term && fold(term, textOf(l)).includes(fold(term, term))));
  const reg = (globalThis as any).CSS?.highlights;
  const HL = (globalThis as any).Highlight;
  if (!reg || !HL) return;
  if (!term) return reg.delete("search");
  const needle = fold(term, term);
  const ranges: Range[] = [];
  for (const l of all) {
    const walk = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode() as Text | null; node; node = walk.nextNode() as Text | null) {
      const hay = fold(term, node.data);
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        const r = new Range();
        r.setStart(node, at);
        r.setEnd(node, at + needle.length);
        ranges.push(r);
      }
    }
  }
  reg.set("search", new HL(...ranges));
}

/**
 * The statusline and command line, and the keys that make the page feel like
 * Vim: a line cursor that j/k move (with counts, gg/G, Ctrl-d/u), yy copies
 * the cursor's line, and : runs a command.
 */
export function VimChrome({ file }: { file: string }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: "j/k move the cursor · / searches · yy copies the line · : for commands" });
  /** what the command line is for: a : command, or a / (forward) or ? (backward) search */
  const [kind, setKind] = useState<":" | "/" | "?">(":");
  /** the last search, for n / N */
  const lastSearch = useRef<{ term: string; dir: 1 | -1 } | null>(null);
  /** where the cursor was when / was typed: Esc puts it back */
  const searchStart = useRef(0);
  const [pos, setPos] = useState("Top");
  const [line, setLine] = useState(1);
  const [toast, setToast] = useState<{ ok: boolean; text: string; id: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cursor = useRef(0);
  /** where V / v started: the selection runs from here to the cursor */
  const anchor = useRef<number | null>(null);
  const [visual, setVisual] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /** the docs have a help index; the statusline names its keys there */
  const [hasIndex, setHasIndex] = useState(false);
  useEffect(() => setHasIndex(Boolean(document.querySelector(".docs .side"))), []);

  /** A notice in the corner, so a copy never goes unnoticed. */
  const notify = (ok: boolean, text: string) => {
    clearTimeout(toastTimer.current);
    setToast({ ok, text, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  /** Mark the lines between the V anchor and the cursor. */
  const paintSelection = (all = lines()) => {
    const a = anchor.current;
    const [from, to] = a === null ? [-1, -2] : [Math.min(a, cursor.current), Math.max(a, cursor.current)];
    all.forEach((l, i) => l.classList.toggle("vsel", i >= from && i <= to));
  };
  const startVisual = () => {
    anchor.current = cursor.current;
    setVisual(true);
    setMsg({ text: "-- VISUAL LINE -- j/k to extend, y to copy, Esc to cancel" });
    paintSelection();
  };
  const endVisual = (text = "") => {
    anchor.current = null;
    setVisual(false);
    setMsg({ text });
    paintSelection();
  };
  /** y in VISUAL: copy the selected lines, one per line. */
  const yankSelection = () => {
    const a = anchor.current ?? cursor.current;
    const [from, to] = [Math.min(a, cursor.current), Math.max(a, cursor.current)];
    const picked = lines().slice(from, to + 1).map(lineText);
    endVisual();
    moveTo(from, false);
    yank(picked.join("\n"), picked.length);
  };

  /** The docs' help index, on the pages that have one. */
  const indexEl = () => document.querySelector<HTMLElement>(".docs .side");
  const indexLinks = (side: HTMLElement) => Array.from(side.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));

  /** Into the help index (showing it first): on the section you're reading, like neo-tree on the open file. */
  const focusIndex = (side: HTMLElement) => {
    side.closest(".docs")?.classList.remove("noside");
    const links = indexLinks(side);
    const heads = lines().filter((l) => l.querySelector("h2"));
    const here = heads.filter((l) => lines().indexOf(l) <= cursor.current).pop()?.id;
    (links.find((a) => a.getAttribute("href") === `#${here}`) ?? links[0])?.focus();
    setMsg({ text: "help index: j/k move · Enter jumps · l or Esc back to the text · <Space>e hides it" });
  };
  /** Back to the text, the cursor where it was. */
  const leaveIndex = () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    setMsg({ text: "" });
  };
  /** <Space>e: open and focus the index, focus it if it's open, close it if you're in it. */
  const toggleIndex = () => {
    const side = indexEl();
    if (!side) return setMsg({ text: "No help index on this page: :help opens the docs" });
    const docs = side.closest(".docs");
    const hidden = docs?.classList.contains("noside");
    if (hidden || !side.contains(document.activeElement)) return focusIndex(side);
    leaveIndex();
    docs?.classList.add("noside");
    setMsg({ text: "help index hidden · <Space>e shows it" });
  };
  /** ]] / [[: the next or previous section heading. */
  const jumpSection = (dir: 1 | -1) => {
    const all = lines();
    const heads = all.flatMap((l, i) => (l.querySelector("h2") ? [i] : []));
    const to = dir > 0 ? heads.find((i) => i > cursor.current) : [...heads].reverse().find((i) => i < cursor.current);
    if (to === undefined) return setMsg({ text: dir > 0 ? "Last section" : "First section" });
    moveTo(to);
  };

  /** Ask for the colorscheme picker: the drawing of vigent has it on the home page, SitePicker everywhere else. */
  const colorscheme = (name?: string) => document.dispatchEvent(new CustomEvent("vigent:colorscheme", { detail: name }));

  /** Put the cursor on line `i` (0-based) and keep it on screen. */
  const moveTo = (i: number, scroll: boolean | "center" = true) => {
    const all = lines();
    if (!all.length) return;
    const n = Math.max(0, Math.min(all.length - 1, i));
    all[cursor.current]?.classList.remove("cursor");
    all[n].classList.add("cursor");
    const was = cursor.current;
    cursor.current = n;
    setLine(n + 1);
    // say what Enter does on lines where it does something
    if (n !== was && anchor.current === null) {
      const hint = enterHint(all[n]);
      if (hint) setMsg({ text: hint });
    }
    paintSelection(all);
    if (!scroll) return;
    // like Vim: the first line shows the top of the buffer, the last one the ~ after it
    if (n === 0) scrollTo(0, 0);
    else if (n === all.length - 1) scrollTo(0, document.documentElement.scrollHeight);
    else all[n].scrollIntoView({ block: scroll === "center" ? "center" : "nearest" });
  };

  /**
   * The next line with `term` after line `from` (before it when dir is -1),
   * wrapping around the buffer like 'wrapscan'.
   */
  const findLine = (term: string, dir: 1 | -1, from: number) => {
    const all = lines();
    const needle = fold(term, term);
    const hits = all.flatMap((l, i) => (fold(term, textOf(l)).includes(needle) ? [i] : []));
    if (!hits.length) return null;
    const ahead = dir > 0 ? hits.find((i) => i > from) : [...hits].reverse().find((i) => i < from);
    const i = ahead ?? (dir > 0 ? hits[0] : hits[hits.length - 1]);
    return { i, wrapped: ahead === undefined, nth: hits.indexOf(i) + 1, total: hits.length };
  };
  /** Search from the cursor, move to the match and say where it is, like Vim with 'shortmess' -S. */
  const searchTo = (term: string, dir: 1 | -1, from = cursor.current) => {
    const prefix = dir > 0 ? "/" : "?";
    const r = findLine(term, dir, from);
    if (!r) {
      setMsg({ text: `E486: Pattern not found: ${term}`, err: true });
      return false;
    }
    moveTo(r.i, "center");
    const wrap = r.wrapped ? (dir > 0 ? "  search hit BOTTOM, continuing at TOP" : "  search hit TOP, continuing at BOTTOM") : "";
    setMsg({ text: `${prefix}${term}  [${r.nth}/${r.total}]${wrap}`, err: false });
    return true;
  };
  /** while typing after / or ?: jump to the first match as you type (incsearch) and highlight them all */
  const previewSearch = (term: string) => {
    paintMatches(term || undefined);
    if (!term) return moveTo(searchStart.current);
    const r = findLine(term, kind === "?" ? -1 : 1, searchStart.current);
    moveTo(r ? r.i : searchStart.current, "center");
  };
  /** n / N: the last search again, the same way or the other way */
  const searchNext = (reverse: boolean) => {
    const last = lastSearch.current;
    if (!last) return setMsg({ text: "E35: No previous regular expression", err: true });
    paintMatches(last.term);
    searchTo(last.term, reverse ? (-last.dir as 1 | -1) : last.dir);
  };

  const yank = (text: string, count = 1) => {
    const shown = text || "(empty line)";
    const done = () => {
      const first = shown.split("\n")[0];
      setMsg({ text: count > 1 ? `${count} lines yanked` : `1 line yanked: "${first.length > 60 ? `${first.slice(0, 60)}…` : first}"` });
      notify(true, count > 1 ? `${count} lines: ${first}…` : shown);
      if (text === INSTALL) {
        document.querySelectorAll<HTMLButtonElement>("[data-yank]").forEach((b) => {
          b.classList.add("done");
          b.textContent = "copied ✓";
          setTimeout(() => {
            b.classList.remove("done");
            b.textContent = "yy copy";
          }, 1800);
        });
      }
    };
    const fallback = () => {
      setMsg({ text: `Copy it: ${shown}` });
      notify(false, shown);
    };
    try {
      navigator.clipboard.writeText(text).then(done, fallback);
    } catch {
      fallback();
    }
  };
  const yankLine = () => {
    const el = lines()[cursor.current];
    if (el) yank(lineText(el));
  };

  const run = (raw: string) => {
    const c = raw.trim().replace(/^:/, "");
    if (!c) return setMsg({ text: "" });
    const word = c.split(/\s+/)[0];
    if (/^\d+$/.test(word)) return moveTo(Number(word) - 1); // :12 goes to line 12
    if (ROUTES[word]) {
      setMsg({ text: `:${c}` });
      location.href = ROUTES[word];
      return;
    }
    if (word === "github" || word === "gh") {
      setMsg({ text: "Opening github.com/farming-labs/vigent" });
      location.href = REPO;
      return;
    }
    if (word === "yy" || word === "yank") return yankLine();
    if (/^noh(l(s(e(a(r(c(h)?)?)?)?)?)?)?$/.test(word)) {
      paintMatches();
      return setMsg({ text: "" });
    }
    if (word === "colorscheme" || word === "colo") return colorscheme(c.split(/\s+/)[1]);
    if (/^q(a|uit|all)?!?$/.test(word)) return setMsg({ text: `Nothing to quit here. In your terminal: ${INSTALL}` });
    setMsg({ text: `E492: Not an editor command: ${c}`, err: true });
  };

  // statusline position: Top / NN% / Bot
  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const y = scrollY;
      setPos(max <= 0 || y <= 2 ? "Top" : y >= max - 2 ? "Bot" : `${Math.round((y / max) * 100)}%`);
    };
    update();
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  }, []);

  // the cursor starts on line 1, or on the section a link points to; a click puts it on that line
  useEffect(() => {
    const toHash = (scroll: boolean) => {
      const target = location.hash && document.getElementById(location.hash.slice(1));
      const i = target ? lines().findIndex((l) => l === target || l.contains(target) || target.contains(l)) : -1;
      moveTo(i >= 0 ? i : 0, scroll);
    };
    toHash(false);
    const onHash = () => toHash(false);
    const onClick = (e: MouseEvent) => {
      const el = e.target as Element;
      if (el.closest?.("[data-yank]")) return yank(INSTALL);
      const scheme = el.closest?.("[data-colorscheme]");
      if (scheme && scheme !== document.documentElement) return colorscheme(scheme.getAttribute("data-colorscheme") ?? undefined);
      if (el.closest?.("a, button, input")) return;
      const l = el.closest?.("main.buffer .l:not(.tilde)");
      if (l) moveTo(lines().indexOf(l as HTMLElement), false);
    };
    addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, []);

  // other parts of the page report in the command line (":colorscheme tokyonight")
  useEffect(() => {
    const onSay = (e: Event) => setMsg({ text: String((e as CustomEvent).detail ?? "") });
    document.addEventListener("vigent:say", onSay);
    return () => document.removeEventListener("vigent:say", onSay);
  }, []);

  // the docs index follows the section you jumped to
  useEffect(() => {
    const mark = () =>
      document.querySelectorAll(".side a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === location.hash));
    mark();
    addEventListener("hashchange", mark);
    return () => removeEventListener("hashchange", mark);
  }, []);

  // normal-mode keys
  useEffect(() => {
    let pending = "";
    let count = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const half = () => {
      const h = lines()[0]?.getBoundingClientRect().height || 23;
      return Math.max(1, Math.floor(innerHeight / h / 2));
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea") || e.metaKey || e.altKey) return;
      const k = e.key;

      // <Space> is the leader, as in LazyVim; on a button it still presses the button
      if (pending === "leader") {
        pending = "";
        clearTimeout(timer);
        if (k === "e") {
          e.preventDefault();
          return toggleIndex();
        }
        if (k === "Escape") return setMsg({ text: "" });
        setMsg({ text: `<Space>${k.length === 1 ? k : ""} isn't mapped here: <Space>e toggles the help index` });
        return;
      }
      if (k === " " && !e.ctrlKey && !(e.target as Element).closest?.("button, summary, [role=button]")) {
        e.preventDefault();
        pending = "leader";
        setMsg({ text: "<Space>  e help index" });
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (pending === "leader") {
            pending = "";
            setMsg({ text: "" });
          }
        }, 1500);
        return;
      }

      // in the help index: j/k between sections, Enter jumps, l / Esc / q go back to the text
      const side = indexEl();
      if (side && !e.ctrlKey && side.contains(document.activeElement)) {
        const links = indexLinks(side);
        const at = links.indexOf(document.activeElement as HTMLAnchorElement);
        const go = (i: number) => {
          e.preventDefault();
          links[Math.max(0, Math.min(links.length - 1, i))]?.focus();
        };
        if (k === "j" || k === "ArrowDown") return go(at + 1);
        if (k === "k" || k === "ArrowUp") return go(at - 1);
        if (k === "G") return go(links.length - 1);
        if (k === "g") {
          if (pending === "g") {
            pending = "";
            return go(0);
          }
          pending = "g";
          clearTimeout(timer);
          timer = setTimeout(() => (pending = ""), 800);
          return;
        }
        if (k === "Enter") {
          // the link itself jumps (the hash moves the cursor); then the keys belong to the text again
          setTimeout(leaveIndex, 0);
          return;
        }
        if (k === "l" || k === "Escape" || k === "q") {
          e.preventDefault();
          return leaveIndex();
        }
        return;
      }

      if (k === "]" || k === "[") {
        if (pending === k) {
          pending = "";
          return jumpSection(k === "]" ? 1 : -1);
        }
        pending = k;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = ""), 800);
        return;
      }

      if (e.ctrlKey) {
        if (k === "d" || k === "u") {
          e.preventDefault();
          moveTo(cursor.current + (k === "d" ? half() : -half()));
        }
        return;
      }
      if (/^[0-9]$/.test(k) && (count || k !== "0")) {
        count += k;
        return;
      }
      const n = Math.max(1, Number(count) || 1);
      const hadCount = count !== "";
      count = "";
      if (k === ":" || k === "/" || k === "?") {
        e.preventDefault();
        pending = "";
        searchStart.current = cursor.current;
        setKind(k);
        setCmd("");
        return;
      }
      if (k === "n" || k === "N") {
        e.preventDefault();
        pending = "";
        return searchNext(k === "N");
      }
      // Esc clears the search highlight, as in LazyVim
      if (k === "Escape" && anchor.current === null && !pending) {
        paintMatches();
        return setMsg({ text: "" });
      }
      if (k === "V" || k === "v") {
        pending = "";
        if (anchor.current === null) startVisual();
        else endVisual();
        return;
      }
      if (anchor.current !== null) {
        if (k === "y") {
          e.preventDefault();
          pending = "";
          return yankSelection();
        }
        if (k === "Escape") return endVisual();
      }
      if (k === "t" && !pending) {
        e.preventDefault();
        return colorscheme();
      }
      // Enter acts on the cursor's line: the theme list opens the picker, the install line copies, a link opens
      if (k === "Enter" && !pending) {
        const el = lines()[cursor.current];
        if (el?.querySelector("[data-colorscheme]")) {
          e.preventDefault();
          return colorscheme();
        }
        if (el?.querySelector("[data-yank], .install")) {
          e.preventDefault();
          return yank(INSTALL);
        }
        const a = el?.querySelector<HTMLAnchorElement>("a[href]");
        if (a && !(e.target as Element).closest?.("a, button")) {
          e.preventDefault();
          return a.click();
        }
      }
      if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        moveTo(cursor.current + n);
      } else if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        moveTo(cursor.current - n);
      } else if (k === "G") moveTo(hadCount ? n - 1 : lines().length - 1);
      else if (k === "g" || k === "y") {
        if (pending === k) {
          pending = "";
          if (k === "g") moveTo(hadCount ? n - 1 : 0);
          else yankLine();
          return;
        }
        pending = k;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = ""), 800);
        return;
      }
      pending = "";
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (cmd !== null) input.current?.focus();
  }, [cmd !== null]);

  const close = (text?: string) => {
    setCmd(null);
    if (kind !== ":") {
      const term = text?.trim();
      if (term) {
        // the search stays highlighted until :noh or Esc
        const dir = kind === "?" ? -1 : 1;
        lastSearch.current = { term, dir };
        paintMatches(term);
        if (!searchTo(term, dir, searchStart.current)) moveTo(searchStart.current);
        return;
      }
      // cancelled: the cursor goes back, the last search's highlight with it
      moveTo(searchStart.current);
      paintMatches(lastSearch.current?.term);
      return setMsg({ text: "" });
    }
    if (text !== undefined) run(text);
    else setMsg({ text: "" });
  };

  return (
    <>
      <SitePicker />
      {toast && (
        <div className="toast" role="status" aria-live="polite" key={toast.id}>
          {toast.ok ? (
            <>
              <span className="ok">✓ yanked</span>
              <code>{toast.text.length > 80 ? `${toast.text.slice(0, 80)}…` : toast.text}</code>
              {toast.text === INSTALL && <span className="cm">paste it in your terminal</span>}
            </>
          ) : (
            <>
              <span>Couldn't copy here. Select and copy:</span>
              <code>{toast.text}</code>
            </>
          )}
        </div>
      )}
      <footer className="status">
        <div className="sl">
          <span className={cmd !== null ? "mode cmdmode" : visual ? "mode visual" : "mode"}>{cmd !== null ? "COMMAND" : visual ? "VISUAL LINE" : "NORMAL"}</span>
          <span className="file">{file}</span>
          <span className="cm hide-sm">[help][RO]</span>
          <span className="fill" />
          <span className="cm hide-sm">
            {hasIndex ? "j/k move · / search · ]] section · <Space>e index · : commands" : "j/k move · / search · yy copy · V select · t theme · : commands"}
          </span>
          <span className="pos">
            {line}:1 · {pos}
          </span>
        </div>
        <div
          className="cmd"
          onClick={() => {
            if (cmd !== null) return;
            setKind(":");
            setCmd("");
          }}
        >
          {cmd !== null ? (
            <>
              <span className="colon">{kind}</span>
              <input
                ref={input}
                id="cmdinput"
                aria-label={kind === ":" ? "Command" : "Search"}
                autoComplete="off"
                spellCheck={false}
                value={cmd}
                onChange={(e) => {
                  setCmd(e.target.value);
                  if (kind !== ":") previewSearch(e.target.value);
                }}
                onBlur={() => close()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    close(cmd);
                  } else if (e.key === "Escape" || (e.key === "Backspace" && !cmd)) {
                    e.preventDefault();
                    close();
                  }
                }}
              />
            </>
          ) : (
            <span className={msg.err ? "msg err" : "msg"}>{msg.text}</span>
          )}
        </div>
      </footer>
    </>
  );
}
