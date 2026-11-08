"use client";

import { useEffect, useState } from "react";

export type OutlineSection = { id: string; tag: string; title: string };

/**
 * The docs page's right rail, like a tagbar split in vim: the page's help tags
 * with the one you're reading marked, and the keys you reach for most.
 */
export function Outline({ sections, keys }: { sections: OutlineSection[]; keys: [string, string][] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const update = () => {
      // the section whose heading has passed under the tabline
      const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tab-h")) || 30) + 48;
      let current = sections[0]?.id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= top) current = s.id;
      }
      // the last sections can't scroll up to the tabline: at the bottom, the one you jumped to if it's on screen, else the last
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
        const hash = decodeURIComponent(location.hash.slice(1));
        const target = sections.some((s) => s.id === hash) ? document.getElementById(hash)?.getBoundingClientRect() : undefined;
        current = target && target.top >= 0 && target.top < innerHeight ? hash : sections[sections.length - 1]?.id;
      }
      setActive(current);
    };
    update();
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update);
    addEventListener("hashchange", update);
    return () => {
      removeEventListener("scroll", update);
      removeEventListener("resize", update);
      removeEventListener("hashchange", update);
    };
  }, [sections]);

  const index = sections.findIndex((s) => s.id === active);

  return (
    <aside className="outline" aria-label="On this page">
      <div className="head">
        <span>" outline</span>
        <span className="pos">
          {index + 1}/{sections.length}
        </span>
      </div>
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} title={s.title} className={s.id === active ? "on" : undefined} aria-current={s.id === active ? "location" : undefined}>
          *{s.tag}*
        </a>
      ))}
      <div className="head keys-head">" quick keys</div>
      <dl>
        {keys.map(([k, what]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
