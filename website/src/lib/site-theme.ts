import { THEMES } from "./themes";

/** The visitor's colorscheme name (the drawing of vigent reads it too). */
export const STORE = "vigent-site-colorscheme";
/** The site colors for that colorscheme, so the <head> script can paint them before anything shows. */
export const VARS_STORE = "vigent-site-vars";

/** The site's own colors, used for "default" and for anything a theme leaves out. */
const SITE_BG = "#0a0a0b";
const SITE_FG = "#d7d8dc";

/** Every token a colorscheme can set; clearing them all puts the site's palette back. */
const TOKENS = [
  "--bg", "--panel", "--bar", "--line", "--cursorline", "--cursor", "--on", "--vsel", "--selection",
  "--fg", "--bright", "--dim", "--faint", "--cyan", "--blue", "--green", "--yellow", "--magenta",
];

const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

export interface SiteTheme {
  name: string;
  vars: Record<string, string>;
  scheme: "dark" | "light";
  /** for <meta name="theme-color">: a plain color, not a color-mix() */
  meta: string;
}

/**
 * The site's tokens for one of vigent's colorschemes. "default" keeps the site's
 * hand-tuned palette; a transparent theme keeps the site's background.
 */
export function siteTheme(name: string): SiteTheme | undefined {
  const t = THEMES[name];
  if (!t) return undefined;
  if (name === "default") return { name, vars: {}, scheme: "dark", meta: SITE_BG };
  const bg = t.bg ?? SITE_BG;
  const fg = t.fg ?? SITE_FG;
  const dim = t.dim ?? mix(fg, 60, bg);
  const vars: Record<string, string | undefined> = {
    "--bg": bg,
    "--panel": t.side && t.side !== bg ? t.side : mix(fg, 4, bg),
    "--bar": mix(fg, 7, bg),
    "--line": mix(t.sep ?? fg, 40, bg),
    "--cursorline": mix(fg, 5, bg),
    "--cursor": mix(fg, 9, bg),
    "--on": mix(fg, 10, bg),
    "--vsel": t.sel ?? mix(t.link ?? fg, 25, bg),
    "--selection": t.sel ?? mix(t.link ?? fg, 30, bg),
    "--fg": fg,
    "--bright": t.title ?? fg,
    "--dim": dim,
    "--faint": mix(dim, 45, bg),
    "--cyan": t.tool,
    "--blue": t.link,
    "--green": t.str,
    "--yellow": t.spin,
    "--magenta": t.user,
  };
  const set = Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => Boolean(e[1])));
  return { name, vars: set, scheme: t.background, meta: bg };
}

/** Paint the whole site in a colorscheme. `keep` also remembers it for the next page and visit. */
export function applySiteTheme(name: string, keep = false) {
  const theme = siteTheme(name);
  if (!theme) return;
  const root = document.documentElement;
  for (const k of TOKENS) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = theme.scheme;
  root.dataset.colorscheme = name;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.meta);
  if (!keep) return;
  try {
    localStorage.setItem(STORE, name);
    localStorage.setItem(VARS_STORE, JSON.stringify(theme));
  } catch {
    // storage off: this page is painted, the next one starts on default
  }
}

/**
 * Runs in <head> before the page paints: the saved colors, so a reload or the
 * next page doesn't flash the default palette first. Kept tiny and dependency-free.
 */
export const PAINT_SAVED_THEME = `try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(VARS_STORE)})||"null");if(t&&t.vars){var r=document.documentElement;for(var k in t.vars)r.style.setProperty(k,t.vars[k]);r.style.colorScheme=t.scheme;r.dataset.colorscheme=t.name;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t.meta)}}catch(e){}`;
