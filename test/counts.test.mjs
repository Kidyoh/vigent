import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

class Agent extends Session {
	constructor(name, lines) {
		super(name, "m");
		for (let i = 1; i <= lines; i++) this.items.push({ kind: "info", text: `${name} line ${i}` });
		this.version++;
	}
	send() {}
	abort() {}
}

function makeApp({ keymap = new Keymap(), lines = 300 } = {}) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 140, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, timeoutlen: 30 }, keymap);
	for (const n of ["alpha", "beta", "gamma", "delta"]) app.addSession(new Agent(n, lines), false);
	app.focusIdx = 0;
	return { app, type: (...keys) => keys.forEach((k) => app.handleInput(k)) };
}

test("a count repeats scrolling, and more digits make a bigger number", () => {
	const { app, type } = makeApp();
	type("5", "k");
	assert.equal(app.scrollOffset, 5);
	type("1", "2", "k");
	assert.equal(app.scrollOffset, 17);
	type("2", "\x04"); // 2<C-d>
	const half = Math.floor(app.contentHeight() / 2);
	assert.equal(app.scrollOffset, 17 - Math.min(17, half * 2));
});

test("digits no longer switch agents; <Space>N does, and gt reads a count", () => {
	const { app, type } = makeApp();
	type("3");
	assert.equal(app.focusedSession.name, "alpha", "a digit alone waits for a key");
	type("\x1b");
	type(" ", "3");
	assert.equal(app.focusedSession.name, "gamma");
	type("2", "g", "t");
	assert.equal(app.focusedSession.name, "beta", "2gt is agent 2, like vim's tabs");
	type("g", "t");
	assert.equal(app.focusedSession.name, "gamma", "gt alone is the next one");
	type("2", "]", "s");
	assert.equal(app.focusedSession.name, "alpha", "]s repeats, wrapping around");
	type("9", "9", "g", "t");
	assert.equal(app.focusedSession.name, "delta", "past the end is the last one");
});

test("{N}G and {N}gg go to a line", () => {
	const { app, type } = makeApp();
	const total = app.buildPaneLines(app.paneWidth()).length;
	type("4", "0", "G");
	const { start, end } = app.viewRange(total);
	assert.ok(start <= 39 && 39 < end, `line 40 is on screen, got ${start}-${end}`);
	assert.ok(start > 0, "and it isn't just the top");
	type("1", "g", "g");
	assert.equal(app.viewRange(total).start, 0);
	type("G");
	assert.equal(app.scrollOffset, 0);
	assert.equal(app.viewRange(total).end, total);
});

test("VISUAL takes counts too", () => {
	const { app, type } = makeApp();
	type("V");
	const start = app.visual.cursor;
	type("1", "0", "k");
	assert.equal(app.visual.cursor, start - 10);
	type("5", "G");
	assert.equal(app.visual.cursor, 4);
});

test("Esc, or a key that isn't mapped, forgets the count", () => {
	const { app, type } = makeApp();
	type("5", "\x1b", "k");
	assert.equal(app.scrollOffset, 1);
	type("5", "x", "k");
	assert.equal(app.scrollOffset, 2);
});

test("0 is part of a count only after another digit; digits in a prompt or after a prefix are just keys", () => {
	const { app, type } = makeApp();
	type("0", "k");
	assert.equal(app.scrollOffset, 1, "0 alone isn't a count");
	type("i", ..."go 12 times");
	assert.equal(app.inputBuf, "go 12 times");
	type("\x1b");
	type(":", ..."b 2", "\r");
	assert.equal(app.focusedSession.name, "beta");
});

test("counts reach windows: 4<C-w>> widens by four, 2<C-w>w is window 2", () => {
	const { app, type } = makeApp();
	type("\x17", "v");
	const area = app.paneArea();
	const before = app.windows.rects(area).get(app.windows.cur).w;
	type("4", "\x17", ">");
	assert.equal(app.windows.rects(area).get(app.windows.cur).w, before + 4);
	type("1", "\x17", "w");
	assert.equal(app.windows.cur, app.windows.all()[0]);
	type("2", "\x17", "w");
	assert.equal(app.windows.cur, app.windows.all()[1]);
});

test("the count shows while you type it, and a huge one is capped", () => {
	const { app, type } = makeApp();
	type("4", "2");
	assert.equal(app.message, "42");
	type("\x1b");
	type(..."123456789");
	assert.equal(app.message, "9999");
	type("k");
	assert.ok(app.scrollOffset <= app.buildPaneLines(app.paneWidth()).length);
});

test("your own mapping on a digit still wins", () => {
	const keymap = new Keymap();
	keymap.set("normal", "7", "session.goto 3");
	const { app, type } = makeApp({ keymap });
	type("7");
	assert.equal(app.focusedSession.name, "gamma");
});
