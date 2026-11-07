import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-settings-"));
process.env.XDG_CONFIG_HOME = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { App } = await import("../dist/app.js");
const { buildKeymap, Keymap, parseKeys } = await import("../dist/keys.js");
const { CONFIG_TEMPLATE, configPath, DEFAULT_UI, loadConfig } = await import("../dist/config.js");
const { setTomlValue } = await import("../dist/config-edit.js");
const { BUILTIN_THEMES, extractPalette, loadTheme, Painter } = await import("../dist/theme.js");

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function makeApp() {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 120, write() {} }, new Painter(loadTheme("default")), { ...DEFAULT_UI }, new Keymap(), {
		root: undefined,
		config: { enabled: true, dir: "../{repo}-worktrees", branch: "{type}/{name}", backend: "auto" },
	});
	app.defaultEngine = () => (app.preferredEngine === "auto" ? "claude" : app.preferredEngine);
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	return { app, overlays, ex };
}

test("config.toml edits keep the file as written", () => {
	let t = setTomlValue(CONFIG_TEMPLATE, undefined, "theme", '"dracula"');
	assert.match(t, /^theme = "dracula"$/m);
	assert.equal(t.match(/^theme = /gm).length, 1);
	t = setTomlValue(t, "ui", "transparent", "true");
	assert.match(t, /^\[ui\][\s\S]*^transparent = true$/m, "the commented template line becomes the setting");
	assert.doesNotMatch(t, /^# transparent = true/m);
	t = setTomlValue(t, "keys.normal", "<Space>D", "false");
	t = setTomlValue(t, "keys.normal", "gd", '":dash<CR>"');
	assert.match(t, /^\[keys\.normal\][^[]*^"<Space>D" = false\ngd = ":dash<CR>"$/m, "in the section, after its examples");
	assert.match(t, /^# --- Theme/m, "comments stay");
	assert.equal(setTomlValue("", "ui", "icons", '"ascii"'), '[ui]\nicons = "ascii"\n');
});

test(":settings changes the look, the engine and the keys live, and w saves them to config.toml", () => {
	const { app, overlays, ex } = makeApp();
	ex("settings");
	const s = overlays.at(-1);
	let screen = plain(s.render(96));
	for (const label of ["Theme", "Transparent background", "Sidebar width", "Engine for new agents", "Worktree storage", "Leader key"]) {
		assert.match(screen, new RegExp(label));
	}
	assert.match(screen, /Engine for new agents +auto \(Claude Code\)/);
	assert.match(screen, /w save to config\.toml/);

	const go = (label) => {
		s.index = s.items.findIndex((i) => i.label === label);
		assert.ok(s.index >= 0, label);
	};
	go("Transparent background");
	s.handleInput("l");
	assert.equal(app.ui.transparent, true);
	assert.equal(app.painter.attr("Normal").bg, "NONE", "applied at once");
	go("Sidebar width");
	s.handleInput("l");
	s.handleInput("l");
	assert.equal(app.ui.sidebar_width, 34);
	go("Engine for new agents");
	s.handleInput("\r"); // auto -> pi
	s.handleInput("l"); // -> claude
	s.handleInput("l"); // -> codex
	assert.equal(app.preferredEngine, "codex");
	assert.equal(app.defaultEngine(), "codex");
	go("Worktree storage");
	s.handleInput("h");
	assert.equal(app.workspace.config.backend, "git");

	// rebind: the dashboard moves from <Space>D to gd
	const dash = s.items.findIndex((i) => i.value().includes("<Space>D"));
	assert.ok(dash >= 0);
	s.index = dash;
	s.handleInput("\r");
	assert.match(plain(s.render(96)), /… +\(Enter keeps, Esc cancels\)/);
	s.handleInput("g");
	s.handleInput("d");
	s.handleInput("\r");
	assert.match(plain(s.render(96)), /gd now: .*· w saves it/);
	assert.equal(app.keymap.lookup("normal", ["g", "d"]).exact?.rhsText, ":dash<CR>");
	assert.equal(app.keymap.lookup("normal", parseKeys("<Space>D")).exact, undefined, "the old key is gone");
	// Esc cancels a capture
	s.handleInput("\r");
	s.handleInput("x");
	s.handleInput("\x1b");
	assert.equal(app.keymap.lookup("normal", ["x"]).exact, undefined);

	s.handleInput("w");
	assert.match(plain(s.render(96)), /saved to .*config\.toml/);
	const { config, warnings } = loadConfig(configPath());
	assert.deepEqual(warnings, []);
	assert.equal(config.ui.transparent, true);
	assert.equal(config.ui.sidebar_width, 34);
	assert.equal(config.engine, "codex");
	assert.equal(config.worktree.backend, "git");
	assert.equal(config.theme, "default");
	const keys = buildKeymap(config.leader, config.keys);
	assert.deepEqual(keys.warnings, []);
	assert.equal(keys.keymap.lookup("normal", ["g", "d"]).exact?.rhsText, ":dash<CR>");
	assert.equal(keys.keymap.lookup("normal", parseKeys("<Space>D")).exact?.rhs[0].kind, "nop", "saved as unbound");
	assert.match(fs.readFileSync(configPath(), "utf8"), /^# vigent config/m, "a fresh config starts from the commented template");

	// q closes; <leader>s opens it again
	s.handleInput("q");
	[" ", "s"].forEach((k) => app.handleInput(k));
	assert.equal(overlays.length, 2);
});

test("25 built-in themes, each with its own colors, and the picker shows them", () => {
	const names = Object.keys(BUILTIN_THEMES);
	assert.equal(names.length, 25);
	for (const n of ["dracula", "onedark", "everforest", "nightfox", "catppuccin-frappe", "catppuccin-macchiato", "tokyonight-storm", "rose-pine-moon", "rose-pine-dawn", "solarized-dark", "solarized-light", "github-dark", "github-light", "monokai-pro", "ayu-mirage"]) {
		assert.ok(names.includes(n), n);
	}
	for (const light of ["rose-pine-dawn", "solarized-light", "github-light", "catppuccin-latte"]) assert.equal(BUILTIN_THEMES[light].background, "light", light);
	const backgrounds = new Set(names.map((n) => extractPalette(BUILTIN_THEMES[n]).bg));
	assert.ok(backgrounds.size >= 24, "distinct backgrounds");

	const { app, overlays, ex } = makeApp();
	ex("colorscheme");
	const picker = overlays.at(-1);
	const raw = picker.render(64).join("\n");
	assert.ok(raw.includes("48;2;14;22;27") || raw.includes("48;2;20;22;27"), "the default theme's background swatch");
	const text = plain(picker.render(64));
	assert.match(text, /● default +dark/);
	assert.match(text, /lazyvim +dark transparent/);
	assert.match(text, /\/ to search/);
	assert.match(text, /j\/k move · Enter pick · q close/);
	const start = app.painter.theme.name;
	picker.handleInput("d"); // letters don't search until /
	assert.equal(app.painter.theme.name, start);
	picker.handleInput("j");
	assert.notEqual(app.painter.theme.name, start, "j moves and previews");
	picker.handleInput("k");
	assert.equal(app.painter.theme.name, start, "k moves back");
	for (const k of "/dracula") picker.handleInput(k);
	assert.match(plain(picker.render(64)), /type to filter · Esc done/);
	const filtered = picker.render(64).join("\n");
	assert.ok(filtered.includes("48;2;40;42;54"), "dracula's own background in its swatch");
	assert.match(plain(picker.render(64)), /dracula/);
	picker.handleInput("\r");
	assert.equal(app.painter.theme.name, "dracula");
});

test(":colorscheme: Esc ends a search, drops the filter, then closes and puts the old theme back", () => {
	const { app, overlays, ex } = makeApp();
	const before = app.painter.theme.name;
	ex("colorscheme");
	const picker = overlays.at(-1);
	for (const k of "/nord") picker.handleInput(k);
	assert.equal(app.painter.theme.name, "nord", "the first match previews");
	picker.handleInput("\x1b");
	assert.match(plain(picker.render(64)), /\/nord/, "out of the search, the filter stays");
	picker.handleInput("\x1b");
	assert.match(plain(picker.render(64)), /\/ to search/, "the filter is gone");
	picker.handleInput("q");
	assert.equal(app.painter.theme.name, before, "q closes and restores");
});
