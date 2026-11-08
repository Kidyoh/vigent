import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { nearest256 } from "../dist/color.js";
import { DEFAULT_UI } from "../dist/config.js";
import { transcriptMarkdown } from "../dist/export.js";
import { TextFloat } from "../dist/float.js";
import { Keymap } from "../dist/keys.js";
import { renderMarkdown } from "../dist/markdown.js";
import { PICKER_ICONS } from "../dist/picker.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter, sgr } from "../dist/theme.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A session whose runs only finish when the test says so. */
class TestSession extends Session {
	sent = [];
	send(text) {
		this.sent.push(text);
		this.pushUser(text);
		this.setState("running");
	}
	finish(reply = "ok") {
		this.items.push({ kind: "agent", text: reply });
		this.setState("idle");
	}
	abort() {
		this.setState("idle");
	}
}

function makeApp({ sessions = [], rows = 30, columns = 110, root } = {}) {
	const overlays = [];
	const tui = {
		requestRender() {},
		showOverlay(component) {
			overlays.push(component);
			return { hide() {} };
		},
	};
	const app = new App(tui, { rows, columns, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root,
		config: { enabled: true, dir: "../x", branch: "{type}/{name}" },
	});
	const copied = [];
	app.clipboard = (text) => (copied.push(text), "terminal");
	let quit = 0;
	app.onQuit = () => quit++;
	for (const s of sessions) app.addSession(s, false);
	app.focusIdx = 0;
	const type = (...keys) => keys.forEach((k) => app.handleInput(k));
	const ex = (cmd) => type(":", ...cmd, "\r");
	const screen = () => strip(app.render(columns).join("\n"));
	return { app, type, ex, screen, overlays, copied, quits: () => quit };
}

const REPLY = [
	"## Plan",
	"Fix the race in **checkout** with `waitFor`:",
	"- reproduce it",
	"- add a wait",
	"```js",
	"await waitFor(() => cart.synced);",
	"expect(badge).toBe(3);",
	"```",
	"Done.",
].join("\n");

function sessionWithReply() {
	const s = new TestSession("fix flaky test", "claude-sonnet-4-5", { branch: "fix/flaky-test" });
	s.items.push({ kind: "user", text: "Find the race" }, { kind: "agent", text: REPLY });
	return s;
}

test("intro screen when no agent is running", () => {
	const { screen } = makeApp();
	const out = screen();
	assert.match(out, /VIGENT|██╗/, "the logo, or its name on a small screen");
	assert.match(out, /New agent: type a task, Enter +i/);
	assert.match(out, /New agent by name +n/);
	assert.match(out, /not a git repository/);
	assert.match(out, /▸ \[no agent\]/, "winbar");
});

test("winbar shows the focused agent, its model and where it works", () => {
	const { screen } = makeApp({ sessions: [sessionWithReply()] });
	assert.match(screen().split("\n")[0], /▸ fix flaky test {2}claude-sonnet-4-5 .*this checkout/);
});

test("markdown in replies: headings, bold, code, bullets, code blocks", () => {
	const P = new Painter(BUILTIN_THEMES.default);
	const { lines, blocks } = renderMarkdown(REPLY, 80, P);
	const plain = lines.map((l) => l.plain);
	assert.deepEqual(plain, [
		"Plan",
		"Fix the race in checkout with waitFor:",
		"• reproduce it",
		"• add a wait",
		"  js",
		"  await waitFor(() => cart.synced);",
		"  expect(badge).toBe(3);",
		"Done.",
	]);
	assert.equal(blocks, 1);
	assert.deepEqual(lines.map((l) => l.block), [undefined, undefined, undefined, undefined, 0, 0, 0, undefined]);
	assert.deepEqual(lines.map((l) => Boolean(l.label)), [false, false, false, false, true, false, false, false], "the language label belongs to the block but isn't copied");
	assert.match(lines[0].text, /\x1b\[1;/, "heading is bold");
});

test("VISUAL mode selects lines and yanks them; ib picks a code block", () => {
	const { app, type, copied, screen } = makeApp({ sessions: [sessionWithReply()] });
	type("V");
	assert.equal(app.mode, "VISUAL");
	assert.match(screen(), /-- VISUAL LINE -- {2}1 line/);
	type("k", "k", "y");
	assert.equal(app.mode, "NORMAL");
	assert.deepEqual(copied, ["  await waitFor(() => cart.synced);\n  expect(badge).toBe(3);\nDone."]);
	assert.match(app.message, /3 lines yanked/);

	type("v", "k", "k", "i", "b", "y");
	assert.equal(copied[1], "  await waitFor(() => cart.synced);\n  expect(badge).toBe(3);");
	type("v", "k", "k", "k", "i", "b", "y");
	assert.equal(copied[2], copied[1], "ib from the block's language label selects the code, not the label");
	copied.pop();

	type("y", "i", "b");
	assert.equal(copied[2], "await waitFor(() => cart.synced);\nexpect(badge).toBe(3);", "yib yanks the nearest block, unindented");
	type("y", "y");
	assert.equal(copied[3], REPLY, "yy yanks the last reply as markdown");
});

test("{ and } jump between messages; ? searches backward", () => {
	const s = sessionWithReply();
	for (let i = 0; i < 12; i++) s.items.push({ kind: "agent", text: `reply ${i}\n${"line\n".repeat(4)}` });
	const { app, type, ex } = makeApp({ sessions: [s], rows: 12 });
	assert.equal(app.scrollOffset, 0);
	type("{");
	const up1 = app.scrollOffset;
	assert.ok(up1 > 0);
	type("{");
	assert.ok(app.scrollOffset > up1);
	type("}");
	assert.equal(app.scrollOffset, up1);

	type("G", "?", ..."reply", "\r");
	const first = app.matchIdx;
	type("n");
	assert.equal(app.matchIdx, first - 1, "n goes up after ?");
	type("N");
	assert.equal(app.matchIdx, first);
	assert.match(app.message, /^\?reply/);
	ex("noh");
});

test("dd asks before killing; :q refuses while agents run", () => {
	const a = new TestSession("a", "m");
	const b = new TestSession("b", "m");
	const { app, type, ex, screen, quits } = makeApp({ sessions: [a, b] });
	type("d", "d");
	assert.match(screen(), /Kill 'a'\? \[y\/N\]/);
	type("n");
	assert.equal(app.sessions.length, 2);
	type("d", "d", "y");
	assert.deepEqual(app.sessions.map((s) => s.name), ["b"]);

	b.send("work");
	ex("q");
	assert.match(app.message, /E37: 1 agent is still running \(add ! to quit anyway\)/);
	assert.equal(quits(), 0);
	type("Z", "Z");
	assert.equal(quits(), 0, "ZZ is :q");
	type("Z", "Q");
	assert.equal(quits(), 1, "ZQ quits anyway");
	ex("q!");
	assert.equal(quits(), 2);
	b.finish();
	ex("q");
	assert.equal(quits(), 3);
});

test(":w saves the transcript as Markdown", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-w-"));
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		const { app, ex } = makeApp({ sessions: [sessionWithReply()] });
		ex("w");
		const file = path.join(dir, "fix-flaky-test.md");
		const md = fs.readFileSync(file, "utf8");
		assert.match(md, /^# fix flaky test\n/);
		assert.match(md, /branch: `fix\/flaky-test`/);
		assert.match(md, /## You\n\nFind the race/);
		assert.match(md, /```js\nawait waitFor/);
		assert.match(app.message, /"fix-flaky-test\.md" \d+L, \d+B written/);
		ex("w");
		assert.match(app.message, /E13: File exists \(add ! to override\)/);
		ex("w! notes/../other.md");
		assert.ok(fs.existsSync(path.join(dir, "other.md")));
		assert.equal(transcriptMarkdown(sessionWithReply()).split("\n")[0], "# fix flaky test");
	} finally {
		process.chdir(cwd);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("prompts queue while the agent runs; :pause holds them, :resume continues", async () => {
	const s = new TestSession("worker", "m");
	const { app, type, ex, screen } = makeApp({ sessions: [s] });
	type("i", ..."first", "\r");
	assert.deepEqual(s.sent, ["first"]);
	type("i", ..."second", "\r");
	assert.deepEqual(s.sent, ["first"], "queued, not sent");
	assert.match(app.message, /queued: 'worker' gets it after the current run \(1 waiting\)/);
	ex("queue third");
	assert.match(screen(), /worker ⧗2/, "sidebar shows the queue");
	assert.match(screen().split("\n")[0], /⧗2 queued/, "winbar too");

	s.finish();
	await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(s.sent, ["first", "second"]);

	ex("pause");
	assert.equal(s.state, "paused");
	assert.match(app.message, /paused 'worker' \(1 queued\)/);
	s.finish(); // the aborted run settling must not release the queue
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(s.state, "paused");
	assert.deepEqual(s.sent, ["first", "second"]);
	ex("resume");
	assert.deepEqual(s.sent, ["first", "second", "third"]);
	s.finish();
	ex("pause");
	ex("resume");
	assert.equal(s.sent.at(-1), "Continue where you left off.");
});

test(":dash lists every agent; Enter jumps to one", () => {
	const sessions = ["one", "two", "three"].map((n) => new TestSession(n, "m", { branch: `feat/${n}`, stat: { files: 1, added: 3, removed: 1 } }));
	sessions[1].send("do it");
	const { app, ex, overlays } = makeApp({ sessions, columns: 130 });
	ex("dash");
	const float = overlays.at(-1);
	const out = strip(float.render(110).join("\n"));
	assert.match(out, /1 ○ one +idle +⎇ feat\/one +\+3 −1/);
	assert.match(out, /2 . two +running/);
	assert.match(out, /3 agents · 1 running/);
	float.handleInput("j");
	float.handleInput("j");
	float.handleInput("\r");
	assert.equal(app.focusIdx, 2);
});

test("]c / [c jump between diff hunks", () => {
	const lines = ["diff --git a/x b/x", "@@ -1 +1 @@", "-a", "+b", ...Array(30).fill(" ctx"), "@@ -40 +40 @@", "-c", "+d"].map((l) => [["NormalFloat", l]]);
	const jumps = [1, 34];
	const f = new TextFloat(new Painter(BUILTIN_THEMES.default), PICKER_ICONS.unicode, "diff", lines, () => 12, () => {}, () => {}, { jumps });
	const first = () => strip(f.render(60)[1]);
	assert.match(first(), /diff --git/);
	f.handleInput("]");
	f.handleInput("c");
	assert.match(first(), /@@ -1 \+1 @@/);
	f.handleInput("]");
	f.handleInput("c");
	assert.match(first(), /ctx|@@ -40/);
	f.handleInput("[");
	f.handleInput("c");
	assert.match(first(), /@@ -1 \+1 @@/);
});

test("256-color fallback for terminals without 24-bit color", () => {
	assert.equal(nearest256("#000000"), 16);
	assert.equal(nearest256("#ffffff"), 231);
	assert.equal(nearest256("#ff0000"), 196);
	assert.equal(nearest256("#808080"), 244);
	assert.equal(sgr({ fg: "#ff0000", bg: "#000000" }, "256"), "\x1b[38;5;196;48;5;16m");
	const { app, ex } = makeApp({ sessions: [sessionWithReply()] });
	assert.match(app.render(110).join(""), /38;2;/);
	ex("set notermguicolors");
	assert.equal(app.painter.colorMode, "256");
	const out = app.render(110).join("");
	assert.match(out, /38;5;/);
	assert.doesNotMatch(out, /38;2;/);
	ex("set tgc");
	assert.equal(app.painter.colorMode, "truecolor");
});

test(":new <task> --model picks a model for one agent", () => {
	const { app, ex } = makeApp();
	const made = [];
	app.newSession = (name, opts) => (made.push({ name, ...opts }), new TestSession(name, opts.model ?? "default"));
	ex("new! docs pass --model claude-haiku-4-5");
	assert.deepEqual(made[0], { name: "docs pass", worktree: false, model: "claude-haiku-4-5", engine: "pi" });
	assert.equal(app.focusedSession.model, "claude-haiku-4-5");
});

test("diff layouts: unified and side by side, with hunk jumps in both", async () => {
	const { splitView, unifiedView } = await import("../dist/diffview.js");
	const diff = [
		"diff --git a/cart.js b/cart.js",
		"index 1..2 100644",
		"--- a/cart.js",
		"+++ b/cart.js",
		"@@ -1,3 +1,4 @@",
		" one",
		"-two",
		"+TWO",
		"+2b",
		" three",
		"diff --git a/new.js b/new.js",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/new.js",
		"@@ -0,0 +1 @@",
		"+hello",
	].join("\n");
	const u = unifiedView(diff);
	assert.deepEqual(u.jumps, [4, 14]);
	const v = splitView(diff, 60);
	const rows = v.lines.map((l) => strip(l.map(([, t]) => t).join("")));
	assert.equal(rows[0], "cart.js");
	assert.match(rows[1], /^@@ -1,3 \+1,4 @@/);
	assert.match(rows[2], /^ +1 one +│ +1 one/);
	assert.match(rows[3], /^ +2 two +│ +2 TWO/, "a removed line sits next to the line that replaced it");
	assert.match(rows[4], /^ +│ +3 2b/, "an extra added line has nothing on the left");
	assert.match(rows[5], /^ +3 three +│ +4 three/);
	assert.equal(rows[7], "new.js");
	assert.match(rows[9], /│ +1 hello/);
	assert.deepEqual(v.jumps, [1, 8]);
	for (const l of v.lines) assert.ok(strip(l.map(([, t]) => t).join("")).length <= 60);
	assert.equal(v.lines[3][1][0], "Removed");
	assert.equal(v.lines[3].at(-1)[0], "Added");

	const f = new TextFloat(new Painter(BUILTIN_THEMES.default), PICKER_ICONS.unicode, "unified", u.lines, () => 20, () => {}, () => {}, {
		jumps: u.jumps,
		alternate: { title: "split", lines: v.lines, jumps: v.jumps },
	});
	assert.match(strip(f.render(64)[0]), /unified/);
	f.handleInput("s");
	assert.match(strip(f.render(64)[0]), /split/);
	assert.match(strip(f.render(64).join("\n")), /two +│ +2 TWO/);
	f.handleInput("s");
	assert.match(strip(f.render(64)[0]), /unified/);
});

test("Esc pressed right before a key isn't lost (arrives as Alt-key)", () => {
	const s = sessionWithReply();
	const { app, type } = makeApp({ sessions: [s] });
	type("i", ..."hi", "\x1b:");
	assert.equal(app.mode, "COMMAND", "Esc then : opened the command line");
	type("\x1b");
	type("V", "\x1bj");
	assert.equal(app.mode, "NORMAL", "Esc then j left VISUAL and scrolled");
	app.keymap.set("normal", "<M-j>", "session.next");
	const before = app.focusIdx;
	type("\x1bj");
	assert.equal(app.focusIdx, before, "a mapped Alt key still works as Alt (one session, so no move)");
	assert.equal(app.mode, "NORMAL");
	type("i", "\x1bG");
	assert.equal(app.mode, "NORMAL");
	assert.equal(app.scrollOffset, 0, "Esc then G (uppercase) went to the bottom");
});

test("markdown tables: box-drawn, aligned, and fit the pane by wrapping cells", () => {
	const P = new Painter(BUILTIN_THEMES.default);
	const md = "| Test | Runs | Notes |\n|:--|--:|:-:|\n| checkout | 50 | waits a fixed **50ms** before checking |\n| cart | 5 | [issue](https://example.com/1) |";
	const wide = renderMarkdown(md, 80, P).lines.map((l) => l.plain);
	assert.deepEqual(wide, [
		"┌──────────┬──────┬────────────────────────────────────┐",
		"│ Test     │ Runs │               Notes                │",
		"├──────────┼──────┼────────────────────────────────────┤",
		"│ checkout │   50 │ waits a fixed 50ms before checking │",
		"│ cart     │    5 │               issue                │",
		"└──────────┴──────┴────────────────────────────────────┘",
	]);
	const narrow = renderMarkdown(md, 30, P).lines.map((l) => l.plain);
	assert.ok(narrow.every((l) => [...l].length <= 30), "nothing past the pane");
	assert.ok(narrow.length > wide.length, "cells wrap instead");
	assert.ok(!wide.join("\n").includes("example.com"), "a link in a table shows its text only");
	assert.equal(renderMarkdown(md, 80, P, "•", 0, { ascii: true }).lines[0].plain[0], "+", "ascii borders");
});

test("markdown: numbered, nested and task lists, rules, quotes that wrap, inline styles", () => {
	const P = new Painter(BUILTIN_THEMES.default);
	const md = [
		"1. first",
		"2. second",
		"  - nested",
		"- [x] done",
		"- [ ] todo",
		"---",
		"> a quote long enough to wrap onto a second line here",
		"*italic* ~~gone~~ [docs](https://vigent.farming-labs.dev/docs) \\*kept\\*",
	].join("\n");
	const { lines } = renderMarkdown(md, 40, P);
	const plain = lines.map((l) => l.plain);
	assert.deepEqual(plain.slice(0, 5), ["1. first", "2. second", "  • nested", "☑ done", "☐ todo"]);
	assert.equal(plain[5], "─".repeat(40));
	assert.ok(plain[6].startsWith("▏ ") && plain[7].startsWith("▏ "), "every wrapped quote line keeps its bar");
	assert.equal(plain.slice(8).join(" "), "italic gone docs (https://vigent.farming-labs.dev/docs) *kept*", "styles, the link with its address, escapes");
	const styled = lines.slice(8).map((l) => l.text).join("");
	assert.match(styled, /\x1b\[3m/, "italic");
	assert.match(styled, /\x1b\[9m/, "strikethrough");
});

test("markdown: text after **bold** or `code` keeps the theme's text color", () => {
	const P = new Painter(BUILTIN_THEMES.default);
	const [line] = renderMarkdown("before **bold** after", 80, P).lines;
	const afterBold = line.text.slice(line.text.indexOf("bold") + 4);
	assert.ok(afterBold.indexOf(P.s("Normal")) < afterBold.indexOf("after") && afterBold.includes(P.s("Normal")), "Normal comes back before 'after'");
});
