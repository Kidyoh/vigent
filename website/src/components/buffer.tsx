import type { ReactNode } from "react";

/** One numbered line of the buffer. Empty when it has no children. */
export function L({ children, id, className }: { children?: ReactNode; id?: string; className?: string }) {
  return (
    <div className="l" id={id}>
      <div className={className ? `t ${className}` : "t"}>{children}</div>
    </div>
  );
}

/** A line past the end of the buffer: `~`. */
export function Tilde({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div className="l tilde" key={i} aria-hidden="true">
          <div className="t" />
        </div>
      ))}
    </>
  );
}

/** The `====` rule between :help sections. */
export function Rule() {
  return (
    <L className="rule">
      <span aria-hidden="true">{"=".repeat(80)}</span>
    </L>
  );
}

/** A :help section heading with its *tag* on the right. */
export function Heading({ id, title, tag, doc }: { id: string; title: string; tag: string; doc?: string }) {
  return (
    <div className="l" id={id}>
      <h2 className="t row">
        <span className="hl">{title}</span>
        {doc ? (
          <a className="tag" href={doc} title="Read this in the docs">
            *{tag}*
          </a>
        ) : (
          <span className="tag">*{tag}*</span>
        )}
      </h2>
    </div>
  );
}

/** "more: |vigent-x|" at the end of a section, pointing into the docs. */
export function More({ href, tag, what }: { href: string; tag: string; what: string }) {
  return (
    <L className="more">
      <span className="cm">{what} →</span> <HelpLink href={href}>{tag}</HelpLink>
    </L>
  );
}

/** `key    what it does`, indented like a :help table. */
export function KeyRow({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <L className="indent">
      <span className="key">{k}</span>
      {children}
    </L>
  );
}

/** A |link| in help syntax; a real link when it has an href. */
export function HelpLink({ children, href }: { children: ReactNode; href?: string }) {
  return href ? (
    <a className="link" href={href}>
      |{children}|
    </a>
  ) : (
    <span className="link">|{children}|</span>
  );
}
