import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { visibleWidth } from "../dist/tui.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const COLS = 202;
const ROWS = 56;

class S extends Session {
	send(t) {
		this.pushUser(t);
	}
	abort() {}
}

/** an agent whose transcript has what broke the screen: a command over several lines, tabs, \r, colors, wide text */
function agent(name) {
	const s = new S(name, "gpt-6-astra", { branch: `fix/${name}`, path: `/wt/${name}`, stat: { files: 3, added: 1109, removed: 917 } });
	s.engine = "codex";
	s.pushUser("what is the status here");
	s.items.push({ kind: "tool", text: "", tool: { name: "bash", summary: "python3 - <<'PY'\nimport pathlib, subprocess\nprint(1)\nPY", output: "ok", folded: true } });
	s.items.push({ kind: "tool", text: "", tool: { name: "Bash", summary: "gh pr view 785\t--json comments", output: "a\tb\n\x1b[31mred\x1b[0m\r\nprogress 10%\rprogress 100%\n漢字 🎉", folded: false } });
	s.items.push({ kind: "agent", text: `**Done.** ${"a long line with 漢字 and 🎉 ".repeat(12)}` });
	s.items.push({ kind: "info", text: "blocked: cat <<EOF\nmulti\nline\nEOF" });
	s.version++;
	return s;
}

function screen(app) {
	const lines = app.render(COLS);
	const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
	return new Promise((resolve) =>
		term.write(`\x1b[H${lines.join("\r\n")}`, () => {
			const buf = term.buffer.active;
			const text = Array.from({ length: buf.length }, (_, y) => buf.getLine(y).translateToString(true));
			resolve({ lines, scrolled: buf.baseY, wrapped: text.filter((_, y) => buf.getLine(y).isWrapped).length, text });
		}),
	);
}

test("every screen row reaches the terminal as one row: a command over several lines can't push the screen down", async () => {
	for (const [theme, icons] of [["tokyonight-moon", undefined], ["nebula", "nerd"]]) {
		const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
		const app = new App(tui, { rows: ROWS, columns: COLS, write() {} }, new Painter(BUILTIN_THEMES[theme]), { ...DEFAULT_UI, ...(icons ? { icons } : {}) }, new Keymap(), { config: { enabled: true } });
		let n = 0;
		app.forkSession = (s) => agent(`${s.name} fork ${++n}`);
		for (const name of ["flaky-tests", "flaky-2"]) app.addSession(agent(name), false);
		app.focusIdx = 0;
		for (const k of ["\x17", "v", "\x17", "v"]) app.handleInput(k); // three windows side by side
		assert.equal(app.windows.count, 3);
		app.setMessage("an error that ran\nover two lines", "ErrorMsg");

		const { lines, scrolled, wrapped, text } = await screen(app);
		assert.equal(lines.length, ROWS, `${theme}: exactly the terminal's rows`);
		for (const [i, l] of lines.entries()) {
			assert.doesNotMatch(l, /[\n\r\t]/, `${theme}: row ${i} has no newline, carriage return or tab`);
			assert.ok(visibleWidth(l) <= COLS, `${theme}: row ${i} fits`);
		}
		assert.equal(scrolled, 0, `${theme}: the terminal never scrolled`);
		assert.equal(wrapped, 0, `${theme}: no row wrapped`);
		const tool = text.find((r) => r.includes("python3 - <<'PY'"));
		assert.match(tool, /python3 - <<'PY' import pathlib/, "the command's lines on one row");
		assert.match(text.at(-1), /an error that ran over two lines/, "the message too, on the last row");
		assert.match(text.at(-2), /NORMAL/, "the statusline stays right above it");
	}
});
