import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI, loadConfig } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { parseStyle, resolveStyle } from "../dist/style.js";
import { BUILTIN_THEMES, loadTheme, Painter } from "../dist/theme.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-style-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
const write = (name, text) => {
	const f = path.join(tmp, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	return f;
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

class S extends Session {
	send(t) {
		this.pushUser(t);
	}
	abort() {}
}

function makeApp(theme = "default", style = {}, ui = {}) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(loadTheme(theme)), { ...DEFAULT_UI, ...ui }, new Keymap());
	app.styleConfig = style;
	const a = new S("cart total", "claude-sonnet-4-5", { branch: "fix/cart-total", path: "/wt/cart", stat: { files: 2, added: 41, removed: 18 } });
	a.engine = "claude";
	a.items.push({ kind: "user", text: "fix the badge" }, { kind: "agent", text: "Done: it sums quantities now." }, { kind: "tool", text: "", tool: { name: "bash", summary: "npm test", output: "", folded: true } });
	const b = new S("docs pass", "claude-haiku-4-5");
	b.engine = "claude";
	app.addSession(a, false);
	app.addSession(b, false);
	app.focusIdx = 0;
	const screen = () => app.render(120).map(strip);
	// the sidebar is the first 30 columns (sidebar_width), then the divider, then the transcript
	const sidebar = () => screen().map((l) => [...l].slice(0, 30).join(""));
	return { app, screen, sidebar };
}

test("[style] in a theme file and in config.toml; mistakes are warnings", () => {
	assert.deepEqual(parseStyle({ sidebar: "cards", messages: "bubbles", tool_icons: "unicode", user_label: "me", icons: { prompt: "λ " } }, "config", []), {
		sidebar: "cards",
		messages: "bubbles",
		tool_icons: "unicode",
		user_label: "me",
		icons: { prompt: "λ " },
	});
	const warnings = [];
	assert.deepEqual(parseStyle({ sidebar: "grid", messages: "labeled", icons: { prompt: 3, sparkle: "✦" }, colour: 1 }, "config", warnings), { messages: "labeled", icons: {} });
	assert.deepEqual(warnings, [
		`config [style]: 'sidebar' should be "tree", "cards", "compact"`,
		"config [style.icons]: 'prompt' should be a string",
		"config [style.icons]: unknown icon 'sparkle' (prompt, worktree, folded, open, cursor, bullet, queued, open_agent, here, unread, light, ok, warn, off, sep, idle, waiting, paused, error, user, agent)",
		"config [style]: unknown option 'colour' (sidebar, messages, tool_icons, separators, user_label, icons, nerd_icons)",
	]);

	// a theme file: its own colors and layout, built on another theme's
	write("xdg/vigent/themes/mine.toml", `extends = "zen"\n[style]\nsidebar = "cards"\n[style.icons]\nprompt = "λ "\n`);
	const mine = loadTheme("mine");
	assert.equal(mine.style.sidebar, "cards", "its own");
	assert.equal(mine.style.messages, "labeled", "zen's, where it says nothing");
	assert.equal(mine.style.icons.prompt, "λ ");
	assert.equal(mine.style.icons.worktree, "↳ ", "zen's icons kept");

	// config.toml's [style] is layered over the theme's, field by field
	const { config } = loadConfig(write("config.toml", `[style]\nmessages = "plain"\n[style.icons]\nidle = "○"\n`));
	const s = resolveStyle(mine.style, config.style);
	assert.deepEqual([s.sidebar, s.messages, s.icons.prompt, s.icons.idle], ["cards", "plain", "λ ", "○"]);
	assert.deepEqual(resolveStyle(), { sidebar: "tree", messages: "plain", userLabel: "You", separators: "none", icons: {}, nerdIcons: {} }, "nothing set: vigent's usual look");
});

test("sidebar styles: tree (default), cards, compact", () => {
	let { sidebar } = makeApp();
	assert.match(sidebar()[1], /^\s+1 ├╴○ cart total/);
	assert.match(sidebar()[2], /│\s+⎇ fix\/cart-t.*… \+41 −18 $/, "a long branch gives way to the counts, a column spare");

	({ sidebar } = makeApp("default", { sidebar: "cards" }));
	const cards = sidebar();
	assert.match(cards[1], /^╭─ 1 ─+╮$/);
	assert.match(cards[2], /^│ ○ cart total\s+│$/);
	assert.match(cards[3], /^│ ⎇ fix\/cart-total \+41 −18\s+│$/);
	assert.match(cards[4], /^│ sonnet-4-5 · 0 tok\s+│$/);
	assert.match(cards[5], /^╰─+╯$/);
	assert.match(cards[6], /^╭─ 2 ─+╮$/, "the next agent's card");

	({ sidebar } = makeApp("default", { sidebar: "compact" }));
	const compact = sidebar();
	assert.match(compact[1], /^▎ {2}1 ○ cart total\s+\+41 −18 $/, "one row, a bar on the focused one, the counts at the right");
	assert.match(compact[2], /^ {7}⎇ fix\/cart-total\s*$/, "the focused agent opens: where it works");
	assert.match(compact[3], /^ {7}sonnet-4-5 · 0 tok\s*$/, "and what it runs on");
	assert.match(compact[4], /^ {3}2 ○ docs pass\s+$/, "the others stay one row");
	assert.match(compact[5], /^~/, "nothing else");
});

test("message styles: plain (default), labeled, bubbles; tool icons", () => {
	let { screen } = makeApp();
	let pane = screen().map((l) => [...l].slice(31).join(""));
	assert.ok(pane.some((l) => /^ ❯ fix the badge/.test(l)));
	assert.ok(pane.some((l) => /^ {2}▸ bash npm test/.test(l)), "no tool icon without a Nerd Font or a style asking for one");

	({ screen } = makeApp("default", { messages: "labeled", tool_icons: "unicode" }));
	pane = screen().map((l) => [...l].slice(31).join(""));
	const you = pane.findIndex((l) => /^ ▎ You\s*$/.test(l));
	assert.ok(you > 0, "a header for your prompt");
	assert.match(pane[you + 1], /^ {3}fix the badge/, "the text under it, indented");
	const reply = pane.findIndex((l) => /^ ▎ Claude Code\s*$/.test(l));
	assert.match(pane[reply + 1], /^ {3}Done: it sums quantities now\./);
	assert.match(pane[reply + 2], /^ {3}▸ ▶ bash npm test/, "tool calls line up, with a unicode icon");

	({ screen } = makeApp("default", { messages: "bubbles", user_label: "me" }));
	pane = screen().map((l) => [...l].slice(31).join(""));
	const top = pane.findIndex((l) => /╭─ me ─+╮ $/.test(l));
	assert.ok(top > 0, "your prompt in a box at the right, with your label");
	assert.match(pane[top], /^\s{20,}╭/, "right-aligned");
	assert.match(pane[top + 1], /│ fix the badge\s*│ $/);
	assert.match(pane[top + 2], /╰─+╯ $/);
	assert.ok(pane.some((l) => /^ ▸ Claude Code/.test(l)), "the reply is named");
});

test("built-in neon and zen carry their own layout; config.toml wins; icons can be replaced", () => {
	assert.deepEqual([BUILTIN_THEMES.neon.style.sidebar, BUILTIN_THEMES.neon.style.messages], ["cards", "bubbles"]);
	assert.deepEqual([BUILTIN_THEMES.zen.style.sidebar, BUILTIN_THEMES.zen.style.messages], ["compact", "labeled"]);

	let { app, sidebar, screen } = makeApp("neon");
	assert.match(sidebar()[1], /^╭─ 1/, "neon: cards");
	assert.match(sidebar()[2], /◇ cart total/, "neon's idle glyph");
	assert.ok(screen().some((l) => /╭─ You ─/.test(l)), "neon: bubbles");

	({ app, sidebar } = makeApp("neon", { sidebar: "tree", icons: { idle: "○" } }));
	assert.match(sidebar()[1], /├╴○ cart total/, "your [style] over the theme's");

	({ sidebar, screen } = makeApp("zen"));
	assert.match(sidebar()[1], /^▎ {2}1 · cart total\s+\+41 −18/, "zen: compact, its own glyphs");
	assert.ok(screen().some((l) => /▎ you/.test(l)), "zen: labeled, 'you'");
});

test(":settings changes the sidebar and message style, and w saves them to [style]", () => {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 120, write() {} }, new Painter(loadTheme("default")), { ...DEFAULT_UI }, new Keymap());
	[":", ..."settings", "\r"].forEach((k) => app.handleInput(k));
	const panel = overlays.at(-1);
	const rows = () => strip(panel.render(110).join("\n"));
	assert.match(rows(), /Sidebar style\s+tree/);
	assert.match(rows(), /Messages\s+plain/);
	panel.handleInput("g"); // from the first row, whatever the list holds
	const before = app.style.sidebar;
	// find and change the two rows through the panel's own keys
	let guard = 0;
	while (app.style.sidebar === before && guard++ < 60) {
		panel.handleInput("j");
		panel.handleInput("l");
		if (app.style.sidebar !== before) break;
		panel.handleInput("h");
	}
	assert.equal(app.style.sidebar, "cards");
	panel.handleInput("j");
	panel.handleInput("l");
	assert.equal(app.style.messages, "labeled");
	panel.handleInput("w");
	const saved = fs.readFileSync(path.join(tmp, "xdg", "vigent", "config.toml"), "utf8");
	assert.match(saved, /\[style\][^[]*sidebar = "cards"/);
	assert.match(saved, /\[style\][^[]*messages = "labeled"/);
});

test("separators: a lualine-style statusline and the agent in a pill, with a Nerd Font; plain without one", () => {
	const raw = (app) => app.render(120);
	// with icons = "nerd": rounded segments (U+E0B4 / U+E0B6), icons on each part
	let { app, screen } = makeApp("default", { separators: "round" }, { icons: "nerd" });
	let status = screen().at(-2);
	assert.match(status, /^\ue0b6 \ue62b NORMAL \ue0b4/, "the mode in a rounded segment, with the vim icon");
	assert.match(status, /\ue0b4 .*claude-sonnet-4-5 /, "the model, with its icon");
	assert.match(status, /\ue0b6 .*0\/2 \ue0b4$/, "the right end mirrors the left");
	assert.match(screen()[0].slice(31), /^ \ue0b6 .*cart total \ue0b4/, "the winbar's agent in a pill");
	assert.match(raw(app).at(-2), /\x1b\[/, "colored");
	assert.equal([...status].length, 120, "the whole width, no more");

	({ screen } = makeApp("default", { separators: "arrow" }, { icons: "nerd" }));
	assert.match(screen().at(-2), /NORMAL \ue0b0/);
	({ screen } = makeApp("default", { separators: "slant" }, { icons: "nerd" }));
	assert.match(screen().at(-2), /NORMAL \ue0bc/);

	// without a Nerd Font the shapes would be empty boxes: the plain statusline
	({ screen } = makeApp("default", { separators: "round" }));
	assert.match(screen().at(-2), /^ NORMAL {2}cart total/);
	assert.doesNotMatch(screen().join("\n"), /[\ue000-\uf8ff]/u, "no Nerd Font glyph anywhere");
});

test("nebula: the dressed-up Neovim look, falling back cleanly without a Nerd Font", () => {
	assert.deepEqual([BUILTIN_THEMES.nebula.style.separators, BUILTIN_THEMES.nebula.style.tool_icons], ["round", "nerd"]);
	let { screen } = makeApp("nebula", {}, { icons: "nerd" });
	const all = screen().join("\n");
	assert.match(all, /\ue0b6 \ue62b NORMAL/, "lualine-style statusline");
	assert.match(all, /\uf120 bash npm test|\uf489 bash npm test|bash npm test/, "tool call");
	assert.match(all, / \uf03a SESSIONS/, "sidebar headers get icons");

	({ screen } = makeApp("nebula"));
	const plain = screen().join("\n");
	assert.doesNotMatch(plain, /[\ue000-\uf8ff]/u, "unicode icons: no Nerd Font glyph shows, not even the theme's own");
	assert.match(plain, /▶ bash npm test/, "tool icons fall back to unicode ones");
	assert.match(plain, /▎ Claude Code/, "labeled messages either way");
});

test("zen with a Nerd Font: [style.nerd_icons] over its plain glyphs, icons on the message headers, engines folded", () => {
	assert.ok(BUILTIN_THEMES.zen.style.nerd_icons.user, "zen has Nerd Font icons for when there's a font for them");
	let { sidebar, screen } = makeApp("zen", {}, { icons: "nerd" });
	assert.match(sidebar()[1], /▎ {2}1 \uf10c cart total/, "the idle state as a Nerd Font circle");
	assert.match(sidebar()[2], /\ue725 fix\/cart-total/, "the branch icon");
	const all = screen().join("\n");
	assert.match(all, /▎ \uf007 you/, "your header has a user icon");
	assert.match(all, /▎ \uf2db Claude Code/, "the reply's header an agent icon");
	assert.match(all, /\ue0b6 \ue62b NORMAL/, "the rounded statusline");

	// without a Nerd Font: zen's own quiet glyphs, no icons on the headers
	({ screen } = makeApp("zen"));
	const plain = screen().join("\n");
	assert.match(plain, /▎ you +\n/, "no icon before it");
	assert.doesNotMatch(plain, /[\ue000-\uf8ff]/u);

	// config.toml's [style.nerd_icons] layers over the theme's, like [style.icons]
	({ sidebar } = makeApp("zen", { nerd_icons: { idle: "\uf111" } }, { icons: "nerd" }));
	assert.match(sidebar()[1], /\uf111 cart total/);
});

test("compact sidebar: engines you have, and one line for the rest", () => {
	const { app, sidebar } = makeApp("default", { sidebar: "compact" });
	app.setEngines([
		{ id: "claude", name: "Claude Code", installed: true, connected: true, detail: "" },
		{ id: "codex", name: "Codex", installed: true, connected: false, detail: "", connect: "codex login" },
		{ id: "pi", name: "pi", installed: false, connected: false, detail: "not installed" },
		{ id: "gemini", name: "Gemini CLI", installed: false, connected: false, detail: "not installed" },
	]);
	const rows = sidebar().join("\n");
	assert.match(rows, /● Claude Code/);
	assert.match(rows, /◐ Codex\s+codex login/);
	assert.doesNotMatch(rows, /Gemini CLI/, "not installed: folded");
	assert.match(rows, /○ 2 more · :checkhealth/);
});

