"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { applySiteTheme, STORE } from "../lib/site-theme";
import { type ThemeColors, THEMES } from "../lib/themes";
import { ColorschemeFloat, swatch } from "./colorscheme-float";

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

/**
 * The drawing of vigent, painted with the colorscheme you pick, and the whole
 * site with it. The picker is vigent's own :colorscheme float (ColorschemeFloat).
 * Open it from the window's title bar, with :colorscheme or t, or by clicking a
 * theme further down the page.
 */
export function ThemeShowcase({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("default");
  const [open, setOpen] = useState(false);
  const before = useRef("default");
  const box = useRef<HTMLDivElement>(null);
  /** where the page was when the picker opened (e.g. the Themes section), to come back to */
  const returnTo = useRef<number | null>(null);
  const comeBack = () => {
    const y = returnTo.current;
    returnTo.current = null;
    if (y !== null && Math.abs(scrollY - y) > 40) scrollTo({ top: y, behavior: "instant" });
  };

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

  const openPicker = () => {
    before.current = theme;
    returnTo.current = scrollY;
    setOpen(true);
    // jump, don't glide: the picker is often far above the Themes section
    box.current?.scrollIntoView({ block: "center", behavior: "instant" });
  };
  const keep = (name: string) => {
    setTheme(name);
    setOpen(false);
    applySiteTheme(name, true);
    document.dispatchEvent(new CustomEvent("vigent:say", { detail: `colorscheme ${name}` }));
    comeBack();
  };
  const cancel = () => {
    setTheme(before.current);
    setOpen(false);
    comeBack();
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
        {open && <ColorschemeFloat current={before.current} onPreview={setTheme} onKeep={keep} onCancel={cancel} />}
      </div>
    </div>
  );
}
