"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type ThemeColors, THEMES } from "../lib/themes";

export const NAMES = Object.keys(THEMES);

/** A theme's look in four squares: background, then three accents. */
export const swatch = (t: ThemeColors) => [t.bg ?? "transparent", t.user, t.str, t.spin].filter(Boolean) as string[];

function fuzzy(name: string, q: string) {
  let i = 0;
  for (const c of name) if (c === q[i]) i++;
  return i === q.length;
}

/**
 * vigent's :colorscheme float: j/k move and preview, Enter keeps it, q or Esc
 * puts the old one back, / searches, g/G jump. Its keys go ahead of the page's
 * own vim keys while it's open. What a preview, keep or cancel paints is the
 * caller's: the drawing of vigent on the home page, the whole site elsewhere.
 */
export function ColorschemeFloat({
  current,
  onPreview,
  onKeep,
  onCancel,
  className = "float",
}: {
  /** the colorscheme in use when the float opened (marked ●, and where the cursor starts) */
  current: string;
  onPreview: (name: string) => void;
  onKeep: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [index, setIndex] = useState(Math.max(0, NAMES.indexOf(current)));
  const [query, setQuery] = useState<string | null>(null); // null: not searching
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => (query ? NAMES.filter((n) => fuzzy(n, query.toLowerCase())) : NAMES), [query]);
  const name = shown[index];

  // moving through the list previews the one under the cursor
  useEffect(() => {
    if (name) onPreview(name);
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [name]);

  /** what the key handler reads, current on every render */
  const live = useRef({ shown, query, name, onKeep, onCancel });
  live.current = { shown, query, name, onKeep, onCancel };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.stopImmediatePropagation();
      const { shown: all, query: q, name: at } = live.current;
      const k = e.key;
      const setQ = (next: string | null) => {
        setIndex(0);
        setQuery(next);
      };
      const move = (by: number) => {
        e.preventDefault();
        if (all.length) setIndex((i) => (i + by + all.length) % all.length);
      };
      if (k === "Enter") {
        e.preventDefault();
        if (at) live.current.onKeep(at);
        return;
      }
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
      if (k === "G") return (e.preventDefault(), setIndex(all.length - 1));
      if (k === "/") return (e.preventDefault(), setQ(""));
      if (k === "q" || k === "Escape") return (e.preventDefault(), live.current.onCancel());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className={className} role="dialog" aria-label="Colorschemes">
      <div className="float-title">Colorschemes</div>
      <div className="float-prompt">{query !== null ? <span className="q">❯ {query}▏</span> : <span className="hint">❯ / to search</span>}</div>
      <ul ref={list} role="listbox" aria-label="Colorschemes">
        {shown.map((n, i) => {
          const th = THEMES[n];
          return (
            // mousemove, not mouseenter: a float opened from the keyboard under a resting pointer keeps its selection
            <li key={n} role="option" aria-selected={i === index} className={i === index ? "on" : undefined} onMouseMove={() => i !== index && setIndex(i)} onClick={() => onKeep(n)}>
              <span className="mark">{n === current ? "●" : " "}</span>
              <span className="nm">{n}</span>
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
  );
}
