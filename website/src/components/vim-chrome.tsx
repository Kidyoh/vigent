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
  colorscheme: "/docs#themes",
  docs: "/docs",
  help: "/docs",
  h: "/docs",
};

/**
 * The statusline and command line, and the keys that make the page feel like
 * Vim: j/k scroll, gg/G jump, yy copies the install command, : runs a command.
 */
export function VimChrome({ file }: { file: string }) {
  const [cmd, setCmd] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean }>({ text: "Type :install, :engines, :keys, :themes, :docs or :github" });
  const [pos, setPos] = useState("Top");
  const input = useRef<HTMLInputElement>(null);

  const yank = () => {
    const done = () => setMsg({ text: `1 line yanked: "${INSTALL}"` });
    const fallback = () => setMsg({ text: `Copy it: ${INSTALL}` });
    try {
      navigator.clipboard.writeText(INSTALL).then(done, fallback);
    } catch {
      fallback();
    }
  };

  const run = (raw: string) => {
    const c = raw.trim().replace(/^:/, "");
    if (!c) return setMsg({ text: "" });
    const word = c.split(/\s+/)[0];
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
    if (word === "yy" || word === "yank") return yank();
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

  // the yy buttons on the page
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if ((e.target as Element).closest?.("[data-yank]")) yank();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lineH = () => parseFloat(getComputedStyle(document.body).lineHeight) || 23;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === ":") {
        e.preventDefault();
        pending = "";
        setCmd("");
        return;
      }
      if (k === "j") scrollBy(0, lineH() * 3);
      else if (k === "k") scrollBy(0, -lineH() * 3);
      else if (k === "G") scrollTo(0, document.documentElement.scrollHeight);
      else if (k === "g" || k === "y") {
        if (pending === k) {
          pending = "";
          if (k === "g") scrollTo(0, 0);
          else yank();
          return;
        }
        pending = k;
        clearTimeout(timer);
        timer = setTimeout(() => (pending = ""), 600);
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
    <footer className="status">
      <div className="sl">
        <span className={cmd !== null ? "mode cmdmode" : "mode"}>{cmd !== null ? "COMMAND" : "NORMAL"}</span>
        <span className="file">{file}</span>
        <span className="cm hide-sm">[help][RO]</span>
        <span className="fill" />
        <span className="cm hide-sm">j/k scroll · : commands</span>
        <span className="pos">{pos}</span>
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
  );
}
