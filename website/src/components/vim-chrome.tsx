"use client";

import { useEffect, useRef, useState } from "react";
import { INSTALL, REPO } from "../lib/site";

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

/**
 * The statusline and command line, and the keys that make the page feel like
 * Vim: a line cursor that j/k move (with counts, gg/G, Ctrl-d/u), yy copies
 * the cursor's line, and : runs a command.
 */
export function VimChrome({ file }: { file: string }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: "j/k move the cursor · yy copies the line · : for commands" });
  const [pos, setPos] = useState("Top");
  const [line, setLine] = useState(1);
  const [toast, setToast] = useState<{ ok: boolean; text: string; id: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cursor = useRef(0);
  /** where V / v started: the selection runs from here to the cursor */
  const anchor = useRef<number | null>(null);
  const [visual, setVisual] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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

  /** Ask the drawing of vigent for its colorscheme picker (on a page without it, go to the one that has it). */
  const colorscheme = (name?: string) => {
    if (document.querySelector(".screen")) document.dispatchEvent(new CustomEvent("vigent:colorscheme", { detail: name }));
    else location.href = "/#top";
  };

  /** Put the cursor on line `i` (0-based) and keep it on screen. */
  const moveTo = (i: number, scroll = true) => {
    const all = lines();
    if (!all.length) return;
    const n = Math.max(0, Math.min(all.length - 1, i));
    all[cursor.current]?.classList.remove("cursor");
    all[n].classList.add("cursor");
    cursor.current = n;
    setLine(n + 1);
    paintSelection(all);
    if (!scroll) return;
    // like Vim: the first line shows the top of the buffer, the last one the ~ after it
    if (n === 0) scrollTo(0, 0);
    else if (n === all.length - 1) scrollTo(0, document.documentElement.scrollHeight);
    else all[n].scrollIntoView({ block: "nearest" });
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
      if (scheme) return colorscheme(scheme.getAttribute("data-colorscheme") ?? undefined);
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
      if (k === ":") {
        e.preventDefault();
        pending = "";
        setCmd("");
        return;
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
    if (text !== undefined) run(text);
    else setMsg({ text: "" });
  };

  return (
    <>
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
          <span className="cm hide-sm">j/k move · yy copy · V select · t theme · : commands</span>
          <span className="pos">
            {line}:1 · {pos}
          </span>
        </div>
        <div className="cmd" onClick={() => cmd === null && setCmd("")}>
          {cmd !== null ? (
            <>
              <span className="colon">:</span>
              <input
                ref={input}
                id="cmdinput"
                aria-label="Command"
                autoComplete="off"
                spellCheck={false}
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
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
