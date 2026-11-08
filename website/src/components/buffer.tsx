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
export function Heading({ id, title, tag }: { id: string; title: string; tag: string }) {
  return (
    <div className="l" id={id}>
      <h2 className="t row">
        <span className="hl">{title}</span>
        <span className="tag">*{tag}*</span>
      </h2>
    </div>
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
