"use client";

import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { applySiteTheme, STORE } from "../lib/site-theme";
import { type ThemeColors, THEMES } from "../lib/themes";

const NAMES = Object.keys(THEMES);

/** The drawing's colors as CSS variables, from one of vigent's themes. */
function vars(t: ThemeColors): CSSProperties {
  const v: Record<string, string> = {};
  const set = (name: string, value: string | undefined) => {
    if (value) v[`--s-${name}`] = value;
  };
  // transparent themes draw on the terminal's own background: keep the site's
  set("bg", t.bg);
  set("fg", t.fg);
  set("side", t.side ?? t.bg);
  set("sep", t.sep);
  set("bar", t.bar);
  set("bar-fg", t.barFg);
  set("dim", t.dim);
  set("title", t.title);
  set("str", t.str);
  set("user", t.user);
  set("tool", t.tool);
  set("link", t.link);
  set("spin", t.spin);
  set("mode-bg", t.modeBg);
  set("mode-fg", t.modeFg);
  set("float", t.float ?? t.bg);
  set("sel", t.sel);
  set("sel-fg", t.selFg);
  return v as CSSProperties;
}

/** A theme's look in four squares: background, then three accents. */
const swatch = (t: ThemeColors) => [t.bg ?? "transparent", t.user, t.str, t.spin].filter(Boolean) as string[];

function fuzzy(name: string, q: string) {
  let i = 0;
  for (const c of name) if (c === q[i]) i++;
  return i === q.length;
}

/**
 * The drawing of vigent, painted with the colorscheme you pick. The picker is
 * vigent's own :colorscheme float: j/k move and preview, Enter keeps it, q or
 * Esc puts the old one back, / searches. Open it from the window's title bar,
 * with :colorscheme or t, or by clicking a theme further down the page.
 */
export function ThemeShowcase({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("default");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState<string | null>(null); // null: not searching
  const before = useRef("default");
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => (query ? NAMES.filter((n) => fuzzy(n, query.toLowerCase())) : NAMES), [query]);
  const current = shown[index];
  /** what the key handler reads; set at once on open, so the very next key reaches the picker */
  const live = useRef({ open, shown, query, current });
  live.current = { ...live.current, open, shown, query, current };

  // remember the last pick for this visitor
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE);
      if (saved && THEMES[saved]) setTheme(saved);
    } catch {
      // storage off: start on default
    }
    setReady(true);
  }, []);

  // the whole site wears the colorscheme too, previews included; Esc puts the old one back
  useEffect(() => {
    if (ready) applySiteTheme(theme);
  }, [ready, theme]);

  const openPicker = (preview?: string) => {
    before.current = theme;
    const start = preview && THEMES[preview] ? preview : theme;
    setQuery(null);
    setIndex(Math.max(0, NAMES.indexOf(start)));
    if (preview && THEMES[preview]) setTheme(preview);
    live.current = { ...live.current, open: true, query: null, shown: NAMES };
    setOpen(true);
    box.current?.scrollIntoView({ block: "center" });
  };
  const keep = (name = live.current.current) => {
    if (!name) return;
    setTheme(name);
    live.current.open = false;
    setOpen(false);
    applySiteTheme(name, true);
    document.dispatchEvent(new CustomEvent("vigent:say", { detail: `colorscheme ${name}` }));
  };
  const cancel = () => {
    setTheme(before.current);
    live.current.open = false;
    setOpen(false);
  };

  // the page (and :colorscheme) asks for the picker
  useEffect(() => {
    const onOpen = (e: Event) => {
      const name = (e as CustomEvent<string | undefined>).detail;
      if (!name) return openPicker();
      if (!THEMES[name]) {
        document.dispatchEvent(new CustomEvent("vigent:say", { detail: `E185: Cannot find color scheme '${name}'` }));
        return;
      }
      // a named theme: show it on vigent right away
      before.current = name;
      keep(name);
      box.current?.scrollIntoView({ block: "center" });
    };
    document.addEventListener("vigent:colorscheme", onOpen);
    return () => document.removeEventListener("vigent:colorscheme", onOpen);
  });

  // live preview: moving through the list repaints the drawing
  useEffect(() => {
    if (open && current) setTheme(current);
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [open, current]);

  // the picker's keys, ahead of the page's own vim keys (one listener; it reads `live`)
  const handlers = useRef({ keep, cancel });
  handlers.current = { keep, cancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { open: isOpen, shown: list, query: q } = live.current;
      if (!isOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      e.stopImmediatePropagation();
      const k = e.key;
      const setQ = (next: string | null) => {
        live.current.query = next;
        live.current.shown = next ? NAMES.filter((n) => fuzzy(n, next.toLowerCase())) : NAMES;
        setIndex(0);
        setQuery(next);
      };
      const move = (by: number) => {
        e.preventDefault();
        if (list.length) setIndex((i) => (i + by + list.length) % list.length);
      };
      if (k === "Enter") return (e.preventDefault(), handlers.current.keep());
      if (k === "ArrowDown" || k === "Tab") return move(1);
      if (k === "ArrowUp") return move(-1);
      if (q !== null) {
        e.preventDefault();
        if (k === "Escape") return setQ(null);
        if (k === "Backspace") return setQ(q ? q.slice(0, -1) : null);
        if (k.length === 1) return setQ(q + k);
        return;
      }
      if (k === "j") return move(1);
      if (k === "k") return move(-1);
      if (k === "g") return (e.preventDefault(), setIndex(0));
      if (k === "G") return (e.preventDefault(), setIndex(list.length - 1));
      if (k === "/") return (e.preventDefault(), setQ(""));
      if (k === "q" || k === "Escape") return (e.preventDefault(), handlers.current.cancel());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const t = THEMES[theme];
  return (
    <div
      ref={box}
      className={`t screen${t.transparent ? " transparent" : ""}${t.background === "light" ? " light" : ""}`}
      style={vars(t)}
      role="group"
      aria-label={`vigent running two agents, in the ${theme} colorscheme`}
    >
      <div className="screen-title">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="name">vigent — ~/code/shop</span>
        <button type="button" className="scheme" onClick={() => (open ? cancel() : openPicker())} aria-expanded={open} title="Pick a colorscheme (or press t)">
          <span className="chips" aria-hidden="true">
            {swatch(t).map((c, i) => (
              <i key={i} style={{ background: c }} />
            ))}
          </span>
          {theme} ▾
        </button>
      </div>
      <div className="screen-body">
        {children}
        {open && (
          <div className="float" role="dialog" aria-label="Colorschemes">
            <div className="float-title">Colorschemes</div>
            <div className="float-prompt">{query !== null ? <span className="q">❯ {query}▏</span> : <span className="hint">❯ / to search</span>}</div>
            <ul ref={list} role="listbox" aria-label="Colorschemes">
              {shown.map((name, i) => {
                const th = THEMES[name];
                return (
                  <li
                    key={name}
                    role="option"
                    aria-selected={i === index}
                    className={i === index ? "on" : undefined}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => keep(name)}
                  >
                    <span className="mark">{name === before.current ? "●" : " "}</span>
                    <span className="nm">{name}</span>
                    <span className="chips" aria-hidden="true">
                      {swatch(th).map((c, j) => (
                        <i key={j} style={{ background: c }} />
                      ))}
                    </span>
                    <span className="tags">
                      {th.background}
                      {th.transparent ? " transparent" : ""}
                    </span>
                  </li>
                );
              })}
              {shown.length === 0 && <li className="none">no match</li>}
            </ul>
            <div className="float-foot">
              {shown.length ? index + 1 : 0}/{shown.length} · {query !== null ? "type to filter · Esc done" : "j/k preview · Enter keep · q close"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
