import { VERSION } from "../lib/site";

export type Tab = "home" | "install" | "engines" | "keys" | "themes" | "docs";

const TABS: { id: Tab; label: string; href: string }[] = [
  { id: "home", label: "vigent.txt", href: "/" },
  { id: "install", label: "install", href: "/#install" },
  { id: "engines", label: "engines", href: "/#engines" },
  { id: "keys", label: "keys", href: "/#keys" },
  { id: "themes", label: "themes", href: "/#themes" },
  { id: "docs", label: "docs", href: "/docs" },
];

/** Vim's tabline, used as the site's top navigation. */
export function Tabline({ active }: { active: Tab }) {
  return (
    <nav className="tabline" aria-label="Site">
      {TABS.map((t) => (
        <a key={t.id} href={t.href} data-tab={t.id} className={t.id === active ? "on" : undefined} aria-current={t.id === active ? "page" : undefined}>
          {t.label}
        </a>
      ))}
      <span className="fill" />
      <a href="https://github.com/farming-labs/vigent">github</a>
      <span className="ver hide-sm">v{VERSION}</span>
    </nav>
  );
}
