import type { ReactNode } from "react";

/** Width of the sidebar column, in characters. */
const SIDE = 31;

type Part = string | [cls: string, text: string];

/** One row: sidebar parts, then main-pane parts. Plain text decides the padding. */
const ROWS: [Part[], Part[]][] = [
  [[["sb", " SESSIONS       2 running"]], ["▸ fix-flaky-test  ", ["cm", "Claude Code · opus · high · riftri"]]],
  [["  1 ├ ", ["str", "●"], " auth-refactor"], []],
  [["  │   ", ["cm", "refactor/auth +41 -18"]], [["kw", "❯"], " the checkout test fails about one run in ten"]],
  [["  2 └ ", ["str", "●"], " fix-flaky-test"], []],
  [["      ", ["cm", "fix/flaky-test +6 -2"]], ["It waits a fixed 50ms for the queue to drain. I'll"]],
  [[], ["wait on the queue's drain event instead."]],
  [[], [" ", ["cm", "▸"], " ", ["tag", "Edit"], " ", ["cm", "test/checkout.test.ts"]]],
  [[["sb", " ENGINES              3/4"]], [" ", ["cm", "▸"], " ", ["tag", "Bash"], " ", ["cm", "npm test -- checkout --repeat 50"]]],
  [["  ", ["str", "●"], " Claude Code   default"], []],
  [["  ", ["str", "●"], " Codex"], ["50 of 50 passed. Ready for ", ["link", ":diff"], "."]],
];

const plain = (parts: Part[]) => parts.map((p) => (typeof p === "string" ? p : p[1])).join("");
const render = (parts: Part[], key: string): ReactNode[] =>
  parts.map((p, i) =>
    typeof p === "string" ? (
      p
    ) : (
      <span className={p[0]} key={`${key}${i}`}>
        {p[1]}
      </span>
    ),
  );

/** vigent at work, drawn in text: two agents in parallel, one fixing a flaky test. */
export function Screen() {
  return (
    <div
      className="t screen"
      role="img"
      aria-label="vigent running two agents in parallel: the sidebar lists them with their branches, the main pane shows a Claude Code agent fixing a flaky test"
    >
      <div className="screen-title" aria-hidden="true">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span>vigent — ~/code/shop</span>
        <span className="cm">2 agents</span>
      </div>
      <pre>
        {ROWS.map(([side, main], r) => (
          <span key={r}>
            {render(side, `s${r}`)}
            {" ".repeat(Math.max(0, SIDE - plain(side).length))}
            {"│ "}
            {render(main, `m${r}`)}
            {"\n"}
          </span>
        ))}
        <span className="st">
          <span className="mode"> NORMAL </span>
          <span> fix-flaky-test  fix/flaky-test</span>
          <span className="fill" />
          <span>opus · high  31.2k tok </span>
        </span>
      </pre>
    </div>
  );
}
