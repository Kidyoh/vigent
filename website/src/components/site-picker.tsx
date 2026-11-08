"use client";

import { useEffect, useRef, useState } from "react";
import { applySiteTheme, STORE } from "../lib/site-theme";
import { THEMES } from "../lib/themes";
import { ColorschemeFloat } from "./colorscheme-float";

const say = (detail: string) => document.dispatchEvent(new CustomEvent("vigent:say", { detail }));

/** The colorscheme the site wears now: what the <head> script painted, or the saved pick. */
function wearing(): string {
  const painted = document.documentElement.dataset.colorscheme;
  if (painted && THEMES[painted]) return painted;
  try {
    const saved = localStorage.getItem(STORE);
    if (saved && THEMES[saved]) return saved;
  } catch {
    // storage off
  }
  return "default";
}

/**
 * :colorscheme on a page without the drawing of vigent (the docs): the same
 * float, over the page, and every preview repaints the whole site. The home
 * page's drawing has its own picker, so this stays out of the way there.
 */
export function SitePicker() {
  const [open, setOpen] = useState(false);
  const before = useRef("default");

  useEffect(() => {
    const onOpen = (e: Event) => {
      if (document.querySelector(".screen")) return;
      const name = (e as CustomEvent<string | undefined>).detail;
      if (!name) {
        before.current = wearing();
        return setOpen(true);
      }
      if (!THEMES[name]) return say(`E185: Cannot find color scheme '${name}'`);
      applySiteTheme(name, true);
      say(`colorscheme ${name}`);
    };
    document.addEventListener("vigent:colorscheme", onOpen);
    return () => document.removeEventListener("vigent:colorscheme", onOpen);
  }, []);

  if (!open) return null;
  return (
    <ColorschemeFloat
      className="float site-float"
      current={before.current}
      onPreview={(name) => applySiteTheme(name)}
      onKeep={(name) => {
        applySiteTheme(name, true);
        setOpen(false);
        say(`colorscheme ${name}`);
      }}
      onCancel={() => {
        applySiteTheme(before.current);
        setOpen(false);
        say("");
      }}
    />
  );
}
