import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { Windows } from "../dist/windows.js";

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
const area = { x: 0, y: 0, w: 100, h: 40 };

class Agent extends Session {
	sent = [];
	constructor(name, lines = 3) {
		super(name, "m");
		for (let i = 1; i <= lines; i++) this.items.push({ kind: "info", text: `${name} line ${i}` });
		this.version++;
	}
	send(text) {
		this.sent.push(text);
	}
	abort() {}
}

const stubFork = (s) => {
	const f = new Agent(`${s.name} (fork)`, 0);
	f.items = [...s.items];
	f.version++;
	return f;
};

function makeApp(names = ["alpha", "beta", "gamma"], { rows = 40, columns = 140, lines = 3 } = {}) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows, columns, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, timeoutlen: 30 }, new Keymap());
	let quits = 0;
	app.onQuit = () => quits++;
	app.forkSession = stubFork;
	for (const n of names) app.addSession(new Agent(n, lines), false);
	app.focusIdx = 0;
	const type = (...keys) => keys.forEach((k) => app.handleInput(k));
	const ex = (cmd) => type(":", ...cmd, "\r");
	const screen = () => strip(app.render(columns).join("\n"));
	const w = "\x17"; // <C-w>
	return { app, type, ex, screen, w, quits: () => quits };
}

test("layout: splits share the room, with one column for the separator, and three in a row are equal", () => {
	const w = new Windows();
	const first = w.cur;
	assert.equal(w.split("row", area), true);
	const rects = w.rects(area);
	assert.deepEqual(rects.get(first), { x: 0, y: 0, w: 50, h: 40 });
	assert.deepEqual(rects.get(w.cur), { x: 51, y: 0, w: 49, h: 40 });
	w.split("row", area);
	const widths = w.all().map((x) => w.rects(area).get(x).w);
	assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `equal widths, got ${widths}`);
});

test("layout: no room means no split; a terminal that shrinks draws only the current window", () => {
	const w = new Windows();
	const small = { x: 0, y: 0, w: 40, h: 7 };
	assert.equal(w.split("row", small), false);
	assert.equal(w.split("column", small), false);
	assert.equal(w.count, 1);
	w.split("row", area);
	assert.equal(w.fits(small), false);
	assert.deepEqual([...w.rects(small).keys()], [w.cur]);
});

test("layout: closing gives the room back, goes to the previous window, and the last one stays", () => {
	const w = new Windows();
	const first = w.cur;
	assert.equal(w.close(first), false);
	w.split("column", area);
	assert.equal(w.close(w.cur), true);
	assert.equal(w.cur, first);
	assert.equal(w.rects(area).get(first).h, 40);
});

test("layout: neighbours follow the screen, across nested splits", () => {
	const w = new Windows();
	const left = w.cur;
	w.split("row", area);
	const top = w.cur;
	w.split("column", area);
	const bottom = w.cur;
	assert.equal(w.neighbour("up", area), top);
	assert.equal(w.neighbour("left", area), left);
	assert.equal(w.neighbour("right", area), undefined);
	assert.equal(w.neighbour("down", area), undefined);
	w.cur = left;
	w.prev = bottom;
	assert.equal(w.neighbour("right", area), bottom, "the window you came from wins, like vim");
});

test("layout: resize moves the border and maximize takes all but the minimum", () => {
	const w = new Windows();
	const first = w.cur;
	w.split("row", area);
	w.resize("row", 5, area);
	assert.equal(w.rects(area).get(w.cur).w, 54);
	w.maximize("row");
	assert.equal(w.rects(area).get(first).w, 24, "the other window keeps its minimum");
	w.equalize();
	assert.equal(w.rects(area).get(first).w, 50);
});

test("<C-w>v forks the agent: a new conversation beside it, with the same history, and a prompt goes to one side only", () => {
	const { app, type, screen, w } = makeApp();
	const alpha = app.focusedSession;
	type(w, "v");
	assert.equal(app.windows.count, 2);
	assert.equal(app.sessions.length, 4, "a new agent");
	const fork = app.focusedSession;
	assert.equal(fork.name, "alpha (fork)");
	assert.match(screen(), /alpha line 1.*alpha line 1/, "both sides show the history");
	type("i", ..."do something else", "\r");
	assert.deepEqual(fork.sent, ["do something else"]);
	assert.deepEqual(alpha.sent, [], "the other side isn't touched");
});

test("<C-w>s forks too; :vsplit with this agent's own number forks, another agent's number just shows it", () => {
	const { app, type, ex, w } = makeApp();
	type(w, "s");
	assert.equal(app.focusedSession.name, "alpha (fork)");
	ex("only");
	type("g", "t");
	assert.equal(app.focusedSession.name, "alpha");
	const before = app.sessions.length;
	ex("vsplit 1");
	assert.equal(app.sessions.length, before + 1);
	ex("only");
	const n = app.sessions.length;
	ex("vsplit 2");
	assert.equal(app.sessions.length, n, "no fork when you name another agent");
	assert.equal(app.focusedSession.name, "beta");
});

test("an engine that can't fork says so and doesn't split", () => {
	const { app, type, screen, w } = makeApp();
	app.forkSession = () => {
		throw new Error("pi can't fork a conversation yet");
	};
	type(w, "v");
	assert.equal(app.windows.count, 1);
	assert.equal(app.sessions.length, 3);
	assert.match(screen(), /can't fork/);
});

test("two agents side by side; <C-w>h / <C-w>l move between them, and ]s changes the current window only", () => {
	const { app, ex, type, screen, w } = makeApp();
	ex("vsplit 2");
	assert.equal(app.windows.count, 2);
	assert.equal(app.focusedSession.name, "beta");
	const shown = screen();
	assert.match(shown, /alpha line 1.*beta line 1/, "both agents, on the same rows");
	type(w, "h");
	assert.equal(app.focusedSession.name, "alpha");
	type(w, "l");
	assert.equal(app.focusedSession.name, "beta");
	type(w, "h", w, "h");
	assert.equal(app.sidebarFocused, true, "past the leftmost window is the sidebar, as before");
});

test("<C-w>s stacks windows, and <C-j> / <C-k> move between them", () => {
	const { app, ex, type, screen } = makeApp();
	ex("split 2");
	const rows = screen().split("\n");
	const a = rows.findIndex((l) => l.includes("alpha line 1"));
	const b = rows.findIndex((l) => l.includes("beta line 1"));
	assert.ok(a >= 0 && b > a, "alpha above beta");
	type("\x0b"); // <C-k>
	assert.equal(app.focusedSession.name, "alpha");
	type("\n"); // <C-j>
	assert.equal(app.focusedSession.name, "beta");
});

test("every window's lines are the same width, so the columns line up", () => {
	const { type, ex, app } = makeApp();
	ex("vsplit 2");
	ex("split 3");
	type("\x17", "h");
	const lines = app.render(140).slice(0, 38).map(strip);
	for (const l of lines) assert.ok([...l].length <= 140, `too wide: ${l}`);
	const sepColumn = lines[5].indexOf("│", 40);
	assert.ok(sepColumn > 0);
	for (const l of lines.slice(1, 30)) assert.equal(l[sepColumn], "│", `separator out of line: ${l}`);
});

test("scrolling in one window leaves the other where it was", () => {
	const { app, type, w } = makeApp(["alpha", "beta"], { lines: 200 });
	type("g", "g");
	const top = app.scrollOffset;
	assert.ok(top > 0);
	type(w, "v");
	assert.equal(app.scrollOffset, top, "a split starts where the window was");
	type("G");
	assert.equal(app.scrollOffset, 0);
	type(w, "h");
	assert.equal(app.scrollOffset, top, "the other window kept its place");
	type(w, "l");
	assert.equal(app.scrollOffset, 0);
});

test(":split and :vsplit take an agent's number or name; :only and :close, like vim", () => {
	const { app, ex, screen } = makeApp();
	ex("vsplit gam");
	assert.equal(app.focusedSession.name, "gamma");
	assert.match(screen(), /alpha line 1.*gamma line 1/);
	ex("close");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "alpha");
	ex("close");
	assert.match(screen(), /E444/);
	ex("sp 2");
	assert.equal(app.focusedSession.name, "beta");
	ex("vs 3");
	assert.equal(app.windows.count, 3);
	ex("only");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "gamma");
	ex("vs nothing");
	assert.match(screen(), /E94/);
	assert.equal(app.windows.count, 1, "a bad name doesn't split");
});

test(":q closes a split before it quits, :qa quits, and ZZ works like :q", () => {
	const { app, ex, type, w, quits } = makeApp();
	type(w, "v");
	ex("q");
	assert.equal(app.windows.count, 1);
	assert.equal(quits(), 0);
	type(w, "v", "Z", "Z");
	assert.equal(app.windows.count, 1);
	assert.equal(quits(), 0);
	type(w, "v");
	ex("qa");
	assert.equal(quits(), 1);
	app.windows.only();
	ex("q");
	assert.equal(quits(), 2);
});

test("killing an agent closes the windows showing it", () => {
	const { app, ex, type, w } = makeApp();
	ex("vsplit 2");
	assert.equal(app.focusedSession.name, "beta");
	ex("kill");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "alpha");
	assert.deepEqual(app.sessions.map((s) => s.name), ["alpha", "gamma"]);
	type(w, "v");
	ex("kill");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "alpha", "killing the fork goes back to the agent it came from");
	type(w, "v", "]", "s");
	assert.equal(app.focusedSession.name, "alpha", "both windows show it now");
	ex("kill");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "gamma", "both windows showed it");
});

test("<C-w>w goes around the windows and the sidebar; with one window it toggles the sidebar as before", () => {
	const { app, type, w } = makeApp();
	type(w, "w");
	assert.equal(app.sidebarFocused, true);
	type(w, "w");
	assert.equal(app.sidebarFocused, false);
	type(w, "v", "]", "s", w, "w");
	assert.equal(app.sidebarFocused, true, "from the last window to the sidebar");
	type(w, "w");
	assert.equal(app.sidebarFocused, false);
	assert.equal(app.windows.cur, app.windows.all()[1], "the sidebar returns to the window you left");
});

test("<C-w>x swaps the two agents, <C-w>o closes the others, <C-w>= evens them out, and :wincmd runs any of them", () => {
	const { app, type, ex, w } = makeApp();
	ex("vsplit 2");
	type(w, "x");
	assert.equal(app.focusedSession.name, "alpha", "the cursor stays put and the agents trade places");
	type(w, ">", w, ">");
	const area = app.paneArea();
	assert.ok(app.windows.rects(area).get(app.windows.cur).w > app.windows.rects(area).get(app.windows.all()[0]).w);
	type(w, "=");
	const [a, b] = app.windows.all().map((x) => app.windows.rects(area).get(x).w);
	assert.ok(Math.abs(a - b) <= 1);
	ex("wincmd h");
	assert.equal(app.focusedSession.name, "beta");
	ex("wincmd q");
	assert.equal(app.windows.count, 1);
	type(w, "v", w, "o");
	assert.equal(app.windows.count, 1);
});

test("the search highlight and VISUAL selection stay in the current window", () => {
	const { app, type, ex, screen, w } = makeApp(["alpha", "alpha2"]);
	ex("vsplit 2");
	type("/", ..."line", "\r");
	assert.match(screen(), /alpha2 line/);
	type(w, "h");
	assert.equal(app.mode, "NORMAL");
	assert.equal(app.searchQuery, "", "changing windows clears it, like changing agents");
});

test("an agent shown in any window doesn't count as unread when it finishes", () => {
	const { app, ex } = makeApp();
	ex("vsplit 2");
	const alpha = app.sessions[0];
	alpha.state = "running";
	app.watchState(alpha);
	alpha.state = "idle";
	app.watchState(alpha);
	assert.equal(app.unread.has(alpha), false);
});

test("with no agent there's nothing to split", () => {
	const { app, type, screen, w } = makeApp([]);
	type(w, "v");
	assert.equal(app.windows.count, 1);
	assert.match(screen(), /no agent/);
});

test("agents work like buffers: :bn :bp :b :ls :bd, and gt / gT", () => {
	const { app, ex, type, screen } = makeApp();
	ex("bn");
	assert.equal(app.focusedSession.name, "beta");
	ex("bnext");
	assert.equal(app.focusedSession.name, "gamma");
	ex("bp");
	assert.equal(app.focusedSession.name, "beta");
	ex("b 1");
	assert.equal(app.focusedSession.name, "alpha");
	ex("b gam");
	assert.equal(app.focusedSession.name, "gamma");
	ex("b #");
	assert.equal(app.focusedSession.name, "alpha");
	type("g", "t");
	assert.equal(app.focusedSession.name, "beta");
	type("g", "T");
	assert.equal(app.focusedSession.name, "alpha");
	ex("bd");
	assert.deepEqual(app.sessions.map((s) => s.name), ["beta", "gamma"]);
	ex("b nope");
	assert.match(screen(), /E94/);
});

test("<C-e> <C-y> <C-n> <C-p> scroll by a line; VISUAL has H M L and page keys", () => {
	const { app, type } = makeApp(["alpha"], { lines: 200 });
	type("\x19");
	assert.equal(app.scrollOffset, 1);
	type("\x10");
	assert.equal(app.scrollOffset, 2);
	type("\x05");
	assert.equal(app.scrollOffset, 1);
	type("\x0e");
	assert.equal(app.scrollOffset, 0);
	type("V", "H");
	const h = app.contentHeight();
	const total = app.buildPaneLines(app.paneWidth()).length;
	assert.equal(app.visual.cursor, total - h);
	type("L");
	assert.equal(app.visual.cursor, total - 1);
	type("M");
	assert.equal(app.visual.cursor, total - h + Math.floor((h - 1) / 2));
	type("\x02");
	assert.ok(app.visual.cursor < total - h, "<C-b> moves a page up");
	const up = app.visual.cursor;
	type("\x06");
	assert.ok(app.visual.cursor > up, "<C-f> moves a page down");
});

test("one window draws exactly as it always did", () => {
	const { screen } = makeApp();
	const rows = screen().split("\n");
	assert.equal(rows.length, 40);
	assert.equal(rows.filter((l) => l.includes("alpha line")).length, 3);
	assert.equal(rows.filter((l) => l.includes("beta line")).length, 0);
});
