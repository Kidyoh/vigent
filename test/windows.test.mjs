import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { Windows } from "../dist/windows.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
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

test("an agent is in one window at most: picking one that's already on screen goes to its window", () => {
	const { app, type, ex, w } = makeApp();
	const alpha = app.focusedSession;
	type(w, "v");
	const fork = app.focusedSession;
	const shown = () => app.windows.all().map((x) => (x === app.windows.cur ? app.focusedSession : x.session).name);
	for (const go of [() => ex("b 1"), () => type(" ", "1"), () => ex("bn"), () => type("g", "t"), () => type("]", "s")]) {
		type(w, "l");
		assert.equal(app.focusedSession, fork);
		go();
		assert.notDeepEqual(new Set(shown()).size, 1, `both windows on one agent: ${shown()}`);
		if (app.focusedSession === alpha) assert.equal(app.windows.cur, app.windows.all()[0], "alpha's own window");
	}
	type(w, "l");
	ex("vsplit 1");
	assert.equal(app.windows.count, 2, ":vsplit of an agent on screen goes to it");
	assert.equal(app.focusedSession, alpha);
	type("i", ..."one place only", "\r");
	assert.deepEqual(alpha.sent, ["one place only"]);
	assert.deepEqual(fork.sent, []);
});

test("an agent still answering isn't forked: the fork would hold half a turn", () => {
	const { app, type, screen, w } = makeApp();
	app.focusedSession.state = "running";
	type(w, "v");
	assert.equal(app.windows.count, 1);
	assert.equal(app.sessions.length, 3);
	assert.match(screen(), /'alpha' is still answering: split once it's done/);
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
	assert.equal(app.focusedSession.name, "alpha", "]s to an agent on screen goes to its window");
	assert.equal(app.windows.cur, app.windows.all()[0]);
	ex("kill");
	assert.equal(app.windows.count, 1);
	assert.equal(app.focusedSession.name, "alpha (fork)", "its window closes; the fork's stays");
});

test("<C-w>w goes around the windows and the sidebar; with one window it toggles the sidebar as before", () => {
	const { app, type, w } = makeApp();
	type(w, "w");
	assert.equal(app.sidebarFocused, true);
	type(w, "w");
	assert.equal(app.sidebarFocused, false);
	type(w, "v", w, "w");
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

test("a split keeps an agent's tabs, carriage returns and cursor codes inside its own window", async () => {
	const messy = (s) => {
		s.items.push({ kind: "user", text: "fix this:\n\tif (x) {\n\t\treturn y;\t// why\n\t}" });
		s.items.push({ kind: "agent", text: "```go\nfunc f() {\n\treturn\n}\n```" });
		s.items.push({
			kind: "tool",
			text: "",
			tool: { name: "bash", summary: "git status\tand npm test", output: "\tmodified:   src/app.ts\r\nprogress 10%\rprogress 100%\n\x1b[2K\x1b[1Gcleared\n\x1b[31mred\x1b[0m done\x07", folded: false },
		});
		s.version++;
	};
	for (const [cmd, columns, rows] of [["split", 120, 40], ["vsplit", 120, 40], ["split", 81, 30], ["vsplit", 81, 30]]) {
		const { app, ex } = makeApp(["alpha"], { rows, columns });
		messy(app.focusedSession);
		ex(cmd);
		const out = app.render(columns);
		for (const l of out) assert.doesNotMatch(l, /[\t\r\x07]|\x1b\[[0-9;]*[A-HJKSTf]/, `${cmd}: nothing on screen moves the cursor or clears the row`);
		// what a terminal shows is what each window meant to show, row for row
		const term = new Terminal({ cols: columns, rows, allowProposedApi: true });
		await new Promise((r) => term.write(out.map((l, i) => `\x1b[${i + 1};1H${l}`).join(""), r));
		const shown = [...Array(rows)].map((_, i) => term.buffer.active.getLine(i).translateToString(true).trimEnd());
		assert.deepEqual(shown, out.map((l) => strip(l).trimEnd()), `${cmd} at ${columns}x${rows}`);
		assert.match(shown.join("\n"), /modified:(?: {3}|\s*\n.*?)src\/app\.ts/, "the tab is spaces, wrapped like any text");
		assert.match(shown.join("\n"), /progress 100%/);
		assert.doesNotMatch(shown.join("\n"), /progress 10%/, "a progress bar shows where it ended up");
	}
});

test("in a split every window's bar is a strip of its own, so you can see where each window starts; one window looks as it did", async () => {
	const P = new Painter(BUILTIN_THEMES.default);
	const [normal, bar] = [P.attr("Normal").bg, P.attr("CursorLine").bg];
	assert.notEqual(normal, bar);
	const barColors = async (app, columns, rows) => {
		const term = new Terminal({ cols: columns, rows, allowProposedApi: true });
		const out = app.render(columns);
		await new Promise((r) => term.write(out.map((l, i) => `\x1b[${i + 1};1H${l}`).join(""), r));
		const b = term.buffer.active;
		const bg = (y, x) => "#" + b.getLine(y).getCell(x).getBgColor().toString(16).padStart(6, "0");
		// a window's bar is the row naming its agent; its color is read at the window's right end, past the name
		return out
			.map((l, y) => [strip(l), y])
			.filter(([l]) => /▸ (alpha|beta)/.test(l))
			.flatMap(([l, y]) => [...l.matchAll(/▸ (alpha|beta)/g)].map((m) => [m[1], bg(y, Math.min(columns - 1, m.index + 40)), y]));
	};
	const one = makeApp(["alpha", "beta"], { rows: 30, columns: 120 });
	assert.deepEqual(await barColors(one.app, 120, 30), [["alpha", normal, 0]], "one window: the bar is on the window's own background");
	const stacked = makeApp(["alpha", "beta"], { rows: 30, columns: 120 });
	stacked.ex("split 2");
	const bars = await barColors(stacked.app, 120, 30);
	assert.equal(bars.length, 2);
	assert.deepEqual(bars.map(([n, c]) => [n, c]), [["alpha", bar], ["beta", bar]], ":split: both bars are strips");
	assert.ok(bars[1][2] > bars[0][2] + 5, "the second bar is where the lower window starts");
	const side = makeApp(["alpha", "beta"], { rows: 30, columns: 120 });
	side.ex("vsplit 2");
	assert.deepEqual((await barColors(side.app, 120, 30)).map(([n, c]) => [n, c]), [["alpha", bar], ["beta", bar]], ":vsplit too");
	// a theme that colors its own winbar keeps that color
	const own = makeApp(["alpha", "beta"], { rows: 30, columns: 120 });
	const base = BUILTIN_THEMES.default;
	own.app.painter = new Painter({ ...base, groups: { ...base.groups, WinBar: { ...base.groups.WinBar, bg: "#5f0000" }, WinBarNC: { bg: "#00005f" } } });
	own.ex("split 2");
	assert.deepEqual((await barColors(own.app, 120, 30)).map(([n, c]) => [n, c]), [["alpha", "#00005f"], ["beta", "#5f0000"]]);
});

test("a fork works in its original's worktree: :diff, the sidebar and the winbar find it there, but it stays the original's", () => {
	const { app, ex, type, screen, w } = makeApp(["alpha"], { rows: 40, columns: 160 });
	const alpha = app.focusedSession;
	alpha.worktree = { path: "/tmp/shop-worktrees/fix-badge", branch: "fix/badge" };
	type(w, "v");
	const fork = app.focusedSession;
	assert.equal(fork.name, "alpha (fork)");
	assert.equal(fork.worktree, undefined, "a fork owns no worktree: :kill! and saving its model never touch the original's");
	assert.equal(fork.worksIn, alpha.worktree);
	assert.equal(screen().match(/fix\/badge/g)?.length >= 2, true, "the sidebar names the branch for both");
	ex("diff");
	assert.doesNotMatch(app.message, /has no worktree/);
	ex("model sonnet");
	assert.equal(fork.model, "sonnet");
	assert.notEqual(alpha.model, "sonnet", "the original keeps its model");
});
