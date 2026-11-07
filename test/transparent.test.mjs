import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

// theme files go to a throwaway config folder
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-themes-"));
process.env.XDG_CONFIG_HOME = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { applySetCommand, DEFAULT_UI, loadConfig } = await import("../dist/config.js");
const { themeNewTemplate } = await import("../dist/theme-new.js");
const { BUILTIN_THEMES, extractPalette, loadTheme, Painter, TRANSPARENT_GROUPS, themesDir } = await import("../dist/theme.js");
const themes = () => {
	fs.mkdirSync(themesDir(), { recursive: true });
	return themesDir();
};

test("lazyvim: tokyonight moon on the terminal's background; selections and badges keep their colors", () => {
	const p = new Painter(loadTheme("lazyvim"));
	assert.equal(p.transparent, true);
	for (const g of ["Normal", "NormalFloat", "FloatBorder", "VigentSidebar", "StatusLine", "WinBar", "LineNr", "WinSeparator"]) {
		assert.ok([undefined, "NONE"].includes(p.attr(g).bg), `${g} is see-through: ${p.attr(g).bg}`);
	}
	assert.equal(p.attr("Normal").fg, "#c8d3f5");
	assert.equal(p.attr("FloatBorder").fg, "#589ed7", "LazyVim's blue float borders");
	assert.equal(p.attr("CursorLineNr").fg, "#ff966c");
	assert.deepEqual(p.attr("Visual"), { bg: "#2d3f76", fg: "#c8d3f5" });
	assert.equal(p.attr("CursorLine").bg, "#2f334d");
	assert.deepEqual(p.attr("VigentModeNormal"), { fg: "#1b1d2b", bg: "#82aaff", bold: true });
	assert.equal(p.attr("PmenuSel").bg, "#363c58");

	// the same theme, solid
	const moon = new Painter(loadTheme("tokyonight-moon"));
	assert.equal(moon.transparent, false);
	assert.equal(moon.attr("Normal").bg, "#222436");
	assert.equal(moon.attr("VigentSidebar").bg, "#1e2030");
	assert.deepEqual(extractPalette(BUILTIN_THEMES.lazyvim), extractPalette(BUILTIN_THEMES["tokyonight-moon"]));
});

test(":set transparent works with any theme; notransparent and transparent& undo it", () => {
	const p = new Painter(loadTheme("gruvbox"));
	const normalBg = p.attr("Normal").bg;
	assert.notEqual(normalBg, "NONE");
	p.setTransparency(true);
	assert.equal(p.attr("Normal").bg, "NONE");
	assert.equal(p.attr("VigentSidebar").bg, "NONE");
	assert.notEqual(p.attr("Visual").bg, "NONE", "selections stay visible");
	// an imported theme that paints other groups on Normal's background goes see-through there too
	const imported = new Painter({ name: "imp", groups: { Normal: { fg: "#eeeeee", bg: "#101010" }, Directory: { fg: "#88aaff", bg: "#101010" }, Search: { bg: "#ffaa00" } } });
	imported.setTransparency(true);
	assert.equal(imported.attr("Directory").bg, "NONE");
	assert.equal(imported.attr("Search").bg, "#ffaa00");
	assert.ok(TRANSPARENT_GROUPS.has("NormalFloat"));

	const lazy = new Painter(loadTheme("lazyvim"));
	lazy.setTransparency(false);
	assert.equal(lazy.attr("Normal").bg, "#222436", ":set notransparent makes lazyvim solid");

	const ui = { ...DEFAULT_UI };
	assert.equal(ui.transparent, "auto");
	applySetCommand(ui, "transparent");
	assert.equal(ui.transparent, true);
	applySetCommand(ui, "notransparent");
	assert.equal(ui.transparent, false);
	applySetCommand(ui, "transparent&");
	assert.equal(ui.transparent, "auto");
	applySetCommand(ui, "transparent!", { transparent: true });
	assert.equal(ui.transparent, false, "toggling while the theme is transparent turns it off");
	assert.match(applySetCommand(ui, "transparent?").message, /notransparent/);
	ui.transparent = "auto";
	assert.match(applySetCommand(ui, "transparent?").message, /transparent=auto/);
	assert.match(applySetCommand(ui, "transparent=maybe").message, /should be true, false or "auto"/);

	const cfg = path.join(dir, "config.toml");
	fs.writeFileSync(cfg, "[ui]\ntransparent = true\n");
	assert.equal(loadConfig(cfg).config.ui.transparent, true);
});

test("theme files: transparent = true, inherited through extends, and overridable", () => {
	fs.writeFileSync(path.join(themes(), "glass.toml"), 'extends = "nord"\ntransparent = true\n');
	fs.writeFileSync(path.join(themes(), "lazy-solid.toml"), 'extends = "lazyvim"\ntransparent = false\n[groups]\nComment = { fg = "#777777" }\n');
	fs.writeFileSync(path.join(themes(), "lazy-mine.toml"), 'extends = "lazyvim"\n[groups]\nComment = { fg = "#888888" }\n');
	assert.equal(new Painter(loadTheme("glass")).attr("Normal").bg, "NONE");
	assert.equal(new Painter(loadTheme("lazy-solid")).attr("Normal").bg, "#222436");
	const mine = new Painter(loadTheme("lazy-mine"));
	assert.equal(mine.attr("Normal").bg, "NONE", "extends lazyvim stays transparent");
	assert.equal(mine.attr("Comment").fg, "#888888");
});

test("vigent theme new: a file pre-filled with the base theme's colors, for every built-in", () => {
	for (const from of Object.keys(BUILTIN_THEMES)) {
		for (const opts of [{}, { palette: true }, { transparent: true }]) {
			const name = `new-${from}-${Object.keys(opts)[0] ?? "plain"}`;
			fs.writeFileSync(path.join(themes(), `${name}.toml`), themeNewTemplate(name, from, opts));
			const t = loadTheme(name);
			const base = new Painter(BUILTIN_THEMES[from]);
			const made = new Painter(t);
			assert.equal(made.transparent, opts.transparent ?? Boolean(BUILTIN_THEMES[from].transparent), name);
			if (!made.transparent) {
				assert.equal(made.attr("Normal").bg, base.attr("Normal").bg, `${name}: same background`);
			}
			assert.equal(made.attr("Normal").fg, base.attr("Normal").fg, `${name}: same text color`);
		}
	}
	// the palette lines are the base theme's real colors
	const text = themeNewTemplate("x", "tokyonight-moon", { palette: true });
	assert.match(text, /^\[palette\]$/m);
	assert.match(text, /^cyan = "#86e1fc"/m);
	assert.match(text, /^extends|^# made from tokyonight-moon's colors$/m);
	assert.doesNotMatch(text, /^extends/m, "--palette: built from the palette alone");
	// without --palette it extends the theme and keeps the palette commented, ready to uncomment
	const plain = themeNewTemplate("y", "lazyvim");
	assert.match(plain, /^extends = "lazyvim"$/m);
	assert.match(plain, /^transparent = true$/m);
	assert.match(plain, /^# \[palette\]$/m);
	assert.match(plain, /^# bg = "#222436" +# background$/m);
});

test(":theme save: what's on screen, :hi changes and transparency included", async () => {
	const { App } = await import("../dist/app.js");
	const { Keymap } = await import("../dist/keys.js");
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 110, write() {} }, new Painter(loadTheme("lazyvim")), { ...DEFAULT_UI }, new Keymap());
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("hi Comment guifg=#a0a0ff gui=italic");
	ex("hi link VigentUser String");
	ex("theme save mine");
	assert.match(app.message, /saved .*mine\.toml/);
	const file = path.join(themesDir(), "mine.toml");
	const text = fs.readFileSync(file, "utf8");
	assert.match(text, /^extends = "lazyvim"$/m, "a small file on top of the built-in");
	assert.match(text, /^Comment = \{ fg = "#a0a0ff", italic = true \}$/m);
	assert.match(text, /^VigentUser = "String"$/m);
	assert.doesNotMatch(text, /^transparent/m, "lazyvim is already transparent");
	assert.equal(app.painter.theme.name, "mine");
	assert.equal(app.painter.attr("Normal").bg, "NONE");

	ex("theme save mine");
	assert.match(app.message, /E13: .* exists \(add ! to overwrite\)/);
	ex("set notransparent");
	ex("hi Normal guibg=#101018");
	ex("theme save! mine");
	const again = loadTheme("mine");
	assert.equal(again.transparent, undefined, "saved solid");
	assert.equal(new Painter(again).attr("Normal").bg, "#101018");
	assert.equal(new Painter(again).attr("Comment").fg, "#a0a0ff", "a theme saved from a file theme carries every group");

	ex("theme save lazyvim");
	assert.match(app.message, /built-in theme; save under another name/);
	ex("theme save");
	assert.match(app.message, /usage: :theme save <name>/);
	ex("colorscheme nord");
	assert.equal(app.painter.theme.name, "nord", ":theme <name> still switches themes");
});

test("a transparent screen never paints Normal's background", async () => {
	const { App } = await import("../dist/app.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 24, columns: 100, write() {} }, new Painter(loadTheme("lazyvim")), { ...DEFAULT_UI }, new Keymap());
	class S extends Session {
		send() {}
		abort() {}
	}
	const s = new S("fix the race", "m");
	s.items.push({ kind: "user", text: "fix it" }, { kind: "agent", text: "Done: `retry()` now waits." });
	app.addSession(s, true);
	const bgOf = (hex) => `48;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`;
	const screen = app.render(100).join("\n");
	for (const solid of ["#222436", "#1e2030"]) assert.ok(!screen.includes(bgOf(solid)), `no ${solid} background`);
	assert.ok(screen.includes(bgOf("#82aaff")), "the NORMAL badge keeps its color");
	assert.ok(screen.includes(bgOf("#2f334d")), "the focused agent's cursorline keeps its color");

	app.handleInput(":");
	for (const k of "set notransparent") app.handleInput(k);
	app.handleInput("\r");
	assert.ok(app.render(100).join("\n").includes(bgOf("#222436")), "solid again");
});
