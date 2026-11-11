import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const K = {
	esc: "\x1b",
	left: "\x1b[D",
	right: "\x1b[C",
	home: "\x1b[H",
	end: "\x1b[F",
	del: "\x1b[3~",
	up: "\x1b[A",
	down: "\x1b[B",
	tab: "\t",
	stab: "\x1b[Z",
	cf: "\x06",
	cr: "\x12",
	cw: "\x17",
	cu: "\x15",
	co: "\x0f",
	cg: "\x07",
	cleft: "\x1b[1;5D",
	enter: "\r",
};

class Agent extends Session {
	constructor(name, lines, prompts = []) {
		super(name, "m");
		for (const p of prompts) this.items.push({ kind: "user", text: p });
		for (let i = 1; i <= lines; i++) this.items.push({ kind: "info", text: `${name} line ${i}` });
		this.version++;
		this.sent = [];
	}
	send(text) {
		this.sent.push(text);
	}
	abort() {}
}

function makeApp({ prompts = [], lines = 300 } = {}) {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 140, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, timeoutlen: 30 }, new Keymap());
	for (const n of ["fix flaky test", "add retries", "alpha"]) app.addSession(new Agent(n, lines, n === "fix flaky test" ? prompts : []), false);
	app.focusIdx = 0;
	const type = (...keys) => keys.forEach((k) => (k.length > 1 && !k.startsWith("\x1b") ? [...k].forEach((c) => app.handleInput(c)) : app.handleInput(k)));
	const strip = (l) => l.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
	const screen = () => app.render(140).map(strip);
	return { app, type, screen, overlays };
}

/** The prompt or command line, with | at the cursor. */
const line = (app) => {
	const buf = app.mode === "INSERT" ? app.input : app.cmd;
	const c = [...buf.text];
	c.splice(buf.pos, 0, "|");
	return c.join("");
};

test("the prompt has a cursor: arrows, Home, End, a word left, Del, and typing goes in where it is", () => {
	const { app, type } = makeApp();
	type("i", "helo world");
	type(K.cleft, K.left, K.left, "l");
	assert.equal(line(app), "hell|o world");
	type(K.home, ">");
	assert.equal(line(app), ">|hello world");
	type(K.del);
	assert.equal(line(app), ">|ello world");
	type(K.end, "!");
	assert.equal(line(app), ">ello world!|");
	type(K.left, K.left, K.left, "\x7f");
	assert.equal(line(app), ">ello wo|ld!", "Backspace takes the character before the cursor");
	type(K.cw);
	assert.equal(line(app), ">ello |ld!", "<C-w> the word before it");
	type(K.cu);
	assert.equal(line(app), "|ld!", "<C-u> everything before it");
});

test("the command line has one too, and <C-b> <C-e> go to its ends", () => {
	const { app, type } = makeApp();
	type(":", "vsplt");
	type(K.left, "i");
	assert.equal(line(app), "vspli|t");
	type("\x02", '"');
	assert.equal(line(app), '"|vsplit');
	type("\x05");
	assert.equal(line(app), '"vsplit|');
});

test("the cursor shows where it is, on the prompt and the command line", () => {
	const { app, type, screen } = makeApp();
	type("i", "abc", K.left);
	assert.match(screen().at(-1), /-- INSERT --.*abc /);
	assert.match(app.render(140).at(-1), /ab(\x1b\[[0-9;]*m)+c(\x1b\[[0-9;]*m)+ /, "c is drawn under the cursor highlight");
	type(K.esc, ":", "xyz", K.home);
	assert.match(app.render(140).at(-1), /:(\x1b\[[0-9;]*m)+x(\x1b\[[0-9;]*m)+yz/);
});

test("<C-f> edits the prompt in NORMAL mode: motions, operators, text objects, undo, then i or Enter", () => {
	const { app, type, screen } = makeApp();
	type("i", "fix the flaky test", K.cf);
	assert.equal(app.mode, "INSERT", "still the prompt");
	assert.match(screen().at(-2), /^ ?NORMAL /, "the statusline says NORMAL");
	assert.match(screen().at(-1), /-- NORMAL --/);
	type("0", "d", "w");
	assert.equal(line(app), "|the flaky test");
	type("w", "c", "i", "w", "slow");
	assert.equal(app.mode, "INSERT");
	assert.match(screen().at(-1), /-- INSERT --/, "c leaves for typing");
	assert.equal(line(app), "the slow| test");
	type(K.cf, "u");
	assert.equal(app.input.text, "the flaky test", "u undoes the change, typing included");
	type("$", "x", "A", "s");
	assert.equal(line(app), "the flaky tess|");
	type(K.cf, "\r");
	assert.equal(app.mode, "NORMAL", "Enter sends");
	assert.deepEqual(app.focusedSession.sent, ["the flaky tess"]);
	assert.equal(app.input.text, "");
});

test("Esc in the line's NORMAL mode goes back to typing; a second Esc leaves INSERT", () => {
	const { app, type } = makeApp();
	type("i", "hello", K.cf, "b", K.esc);
	assert.equal(app.mode, "INSERT");
	type("x");
	assert.equal(line(app), "x|hello");
	type(K.esc);
	assert.equal(app.mode, "NORMAL");
	type("i");
	assert.equal(line(app), "x|hello", "the draft and its cursor wait for you");
});

test("y and d in the line's NORMAL mode fill a register; <C-r>\" puts it in while typing", () => {
	const { app, type } = makeApp();
	type("i", "alpha beta", K.cf, "0", "y", "w", "A", " ", K.cr, '"');
	assert.equal(line(app), "alpha beta alpha |");
});

test("the : line has NORMAL mode too, and Enter runs what it shows", () => {
	const { app, type } = makeApp();
	type(":", "vsplit 3", K.cf, "r", "2", "\r");
	assert.equal(app.mode, "NORMAL");
	assert.equal(app.windows.count, 2);
	assert.equal(app.focusedSession.name, "add retries");
});

test("<Up> and <Down> walk this agent's prompts, only the ones starting with what's typed", () => {
	const { app, type } = makeApp({ prompts: ["fix the login", "add tests", "fix the logout"] });
	type("i", K.up);
	assert.equal(app.input.text, "fix the logout");
	type(K.up, K.up);
	assert.equal(app.input.text, "fix the login");
	type(K.up);
	assert.equal(app.input.text, "fix the login", "no older one: it stays");
	type(K.down, K.down, K.down);
	assert.equal(app.input.text, "", "past the newest is what you'd typed");
	type("add", K.up);
	assert.equal(app.input.text, "add tests");
	type(K.down);
	assert.equal(app.input.text, "add");
});

test("the command line and search remember what ran, each their own", () => {
	const { app, type } = makeApp();
	type(":", "noh", K.enter, ":", "marks", K.enter, "/", "line 2", K.enter);
	type(":", K.up);
	assert.equal(app.cmdBuf, "marks");
	type(K.up);
	assert.equal(app.cmdBuf, "noh");
	type("\x0e", K.esc);
	type("/", K.up);
	assert.equal(app.cmdBuf, "line 2");
	type(K.esc, ":", "history", K.enter);
});

test("<Tab> completes commands, agents and themes, and goes through them; <S-Tab> goes back", () => {
	const { app, type, screen } = makeApp();
	type(":", "vs", K.tab);
	assert.equal(app.cmdBuf, "vsplit");
	type(K.esc, ":", "b fla", K.tab);
	assert.equal(app.cmdBuf, "b fix flaky test", "an agent, from anywhere in its name");
	type(K.esc, ":", "b ", K.tab);
	assert.equal(app.cmdBuf, "b fix flaky test");
	assert.match(screen().at(-2), /fix flaky test\s+add retries\s+alpha/, "the wildmenu over the statusline");
	type(K.tab);
	assert.equal(app.cmdBuf, "b add retries");
	type(K.stab, K.stab);
	assert.equal(app.cmdBuf, "b ", "past the first is what you typed");
	type(K.tab, "x");
	assert.equal(app.cmdBuf, "b fix flaky testx", "typing ends it");
	assert.doesNotMatch(screen().at(-2), /add retries\s+alpha/);
	type(K.esc, ":", "colo tokyo", K.tab);
	assert.match(app.cmdBuf, /^colo tokyonight/);
	type(K.esc, ":", "zzz", K.tab);
	assert.equal(app.cmdBuf, "zzz", "nothing fits: nothing changes");
});

test("while you type a command, what fits shows: the rest of the first match dim after the cursor, every match over the statusline; <Tab> puts it in", () => {
	const { app, type, screen } = makeApp();
	const raw = () => app.render(140).at(-1);
	type(":", "perm");
	assert.equal(screen().at(-1).trimEnd(), ":permissions", "the rest of the command shows as you type");
	assert.equal(app.cmdBuf, "perm", "shown, not typed: Enter runs what you typed");
	assert.ok(raw().includes(app.painter.p("NonText", "ssions")), "dim, the cursor on its first letter");
	assert.ok(raw().indexOf("perm") < raw().indexOf("ssions"), "after what's typed");
	assert.doesNotMatch(screen().at(-2), /permissions/, "one match: no list");
	type(K.tab);
	assert.equal(app.cmdBuf, "permissions", "<Tab> puts in what was shown");

	type(K.esc, ":", "co");
	assert.match(screen().at(-2), /^ colorscheme\s+cost\s*$/, "every command that fits, over the statusline");
	assert.equal(screen().at(-1).trimEnd(), ":colorscheme");
	type(K.tab, K.tab);
	assert.equal(app.cmdBuf, "cost", "<Tab> goes through them as before");

	type(K.esc, ":", "colorscheme tokyo");
	assert.match(screen().at(-1), /^:colorscheme tokyonight/, "arguments too: themes");
	type(K.esc, ":", "b add");
	assert.equal(screen().at(-1).trimEnd(), ":b add retries", "and agents");

	type(K.esc, ":", "zzz");
	assert.equal(screen().at(-1).trimEnd(), ":zzz", "nothing fits: nothing shows");
	type(K.esc, ":", "permissions");
	assert.equal(screen().at(-1).trimEnd(), ":permissions", "typed in full: nothing more to show");
	type(K.esc, ":", "perm", K.left);
	assert.equal(screen().at(-1).trimEnd(), ":perm", "only with the cursor at the end");
});

test("m{a-z} sets a mark, '{a-z} goes back to it, '' and <C-o> undo jumps, <Tab> redoes them", () => {
	const { app, type, overlays } = makeApp();
	const top = () => app.viewRange(app.buildPaneLines(app.paneWidth()).length).start;
	type("5", "0", "k");
	const marked = top();
	type("m", "a", "g", "g");
	assert.equal(top(), 0);
	type("'", "a");
	assert.equal(top(), marked);
	type("'", "'");
	assert.equal(top(), 0, "'' goes back to before the jump");
	type("'", "'");
	assert.equal(top(), marked, "and again toggles");
	type("G");
	const bottom = top();
	type(K.co);
	assert.equal(top(), marked);
	type(K.co);
	assert.equal(top(), 0);
	type(K.tab, K.tab);
	assert.equal(top(), bottom, "<Tab> comes forward to where <C-o> started");
	type("'", "b");
	assert.match(app.message, /E20: Mark not set/);
	type(":", "marks", K.enter);
	assert.match(overlays.at(-1).render(90).join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /mark\s+line\s+text[^\n]*\n[^\n]* a\s+\d+ /);
	type("q", ":", "jumps", K.enter);
	assert.match(overlays.at(-1).render(90).join("\n").replace(/\x1b\[[0-9;]*m/g, ""), /jump\s+line\s+text/);
});

test("marks belong to the agent they were set in", () => {
	const { app, type } = makeApp();
	type("5", "0", "k", "m", "a", "g", "t", "'", "a");
	assert.match(app.message, /E20/);
});

test("zz, zt and zb move the VISUAL cursor's line; gv selects the last selection again", () => {
	const { app, type } = makeApp();
	const range = () => app.viewRange(app.buildPaneLines(app.paneWidth()).length);
	type("V", "4", "0", "k", "z", "t");
	assert.equal(range().start, app.visual.cursor);
	type("z", "b");
	assert.equal(range().end - 1, app.visual.cursor);
	type("z", "z");
	const { start, end } = range();
	assert.ok(Math.abs(app.visual.cursor - (start + (end - start - 1) / 2)) <= 1, "in the middle");
	const sel = { ...app.visual };
	type(K.esc, "G", "g", "v");
	assert.equal(app.mode, "VISUAL");
	assert.deepEqual(app.visual, sel);
	type(K.esc, "z", "z");
	assert.match(app.message, /zz, zt and zb/, "NORMAL with no search says why nothing moved");
});

test("I and A start typing at the prompt's start or end; <C-g> says where you are", () => {
	const { app, type } = makeApp();
	type("i", "middle", K.esc, "I", "<", K.esc, "A", ">");
	assert.equal(line(app), "<middle>|");
	type(K.esc, K.cg);
	const total = app.buildPaneLines(app.paneWidth()).length;
	assert.equal(app.message, `"fix flaky test" ${total} lines --100%--`);
	type("g", "g", K.cg);
	assert.match(app.message, /--\d%--$/, "near the top, a small share");
});

test("a prompt still waiting in the queue is the newest one <Up> finds", () => {
	const { app, type } = makeApp({ prompts: ["first"] });
	app.focusedSession.state = "running";
	type("i", "second", K.enter);
	assert.deepEqual(app.focusedSession.queue, ["second"]);
	type("i", K.up);
	assert.equal(app.input.text, "second");
	type(K.up);
	assert.equal(app.input.text, "first");
});
