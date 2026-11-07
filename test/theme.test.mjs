import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fromPalette } from "../dist/palette.js";
import { BUILTIN_THEMES, buildTheme, loadTheme, normalizeGroups, Painter, sgr } from "../dist/theme.js";

const imported = {
	name: "imported",
	groups: {
		Normal: { fg: "#bcbcbc", bg: "#1c1c1c" },
		Function: { fg: "#87afaf" },
		String: { fg: "#87af87" },
		Statement: { fg: "#d7af87" },
		WarningMsg: { fg: "#d7d787" },
		WinBar: { bold: true },
		CursorLineNr: { link: "Title" },
		Title: { fg: "#ffffff", bold: true },
	},
};

test("links in the theme are followed", () => {
	const p = new Painter(imported);
	assert.deepEqual(p.attr("CursorLineNr"), { fg: "#ffffff", bold: true });
});

test("a group without a foreground takes Normal's", () => {
	const p = new Painter(imported);
	assert.equal(p.attr("WinBar").fg, "#bcbcbc");
	assert.equal(p.attr("WinBar").bold, true);
});

test("missing groups fall back through vim-style links to Normal", () => {
	const p = new Painter(imported);
	assert.deepEqual(p.attr("NoSuchGroup"), imported.groups.Normal);
	assert.equal(p.attr("VigentTool").fg, "#87afaf"); // VigentTool -> Function
});

test("mode badges are derived from the theme's syntax colors", () => {
	const p = new Painter(imported);
	assert.deepEqual(p.attr("VigentModeNormal"), { fg: "#1c1c1c", bg: "#87afaf", bold: true });
	assert.equal(p.attr("VigentModeInsert").bg, "#87af87");
	assert.equal(p.attr("VigentModeVisual").bg, "#d7af87");
	assert.equal(p.attr("VigentModeCommand").bg, "#d7d787");
});

test("sidebar uses tree plugin colors, else a shaded Normal background", () => {
	const shaded = new Painter(imported).attr("VigentSidebar");
	assert.notEqual(shaded.bg, "#1c1c1c");
	const tree = new Painter({ ...imported, groups: { ...imported.groups, NvimTreeNormal: { bg: "#101010" } } });
	assert.equal(tree.attr("VigentSidebar").bg, "#101010");
	const neo = new Painter({ ...imported, groups: { ...imported.groups, NeoTreeNormal: { bg: "#202020" } } });
	assert.equal(neo.attr("VigentSidebar").bg, "#202020");
});

test("overrides merge onto the theme and survive theme switches", () => {
	const p = new Painter(imported, { Normal: { bg: "NONE" } });
	assert.deepEqual(p.attr("Normal"), { fg: "#bcbcbc", bg: "NONE" });
	// NONE is the terminal's own background (49), which also clears one a previous segment set
	assert.equal(sgr(p.attr("Normal")), "\x1b[38;2;188;188;188;49m");
	p.setTheme(BUILTIN_THEMES.gruvbox);
	assert.equal(p.attr("Normal").bg, "NONE");
});

test(":hi, :hi link and :hi clear", () => {
	const p = new Painter(imported);
	const gen = p.generation;
	p.highlight("Comment", { fg: "#ff0000" });
	p.highlight("Comment", { italic: true });
	assert.deepEqual(p.attr("Comment"), { fg: "#ff0000", italic: true });
	assert.ok(p.generation > gen);
	p.highlight("Comment", { italic: false });
	assert.equal(p.attr("Comment").italic, false, "gui=NONE-style overrides switch attributes off");
	p.link("VigentUser", "String");
	assert.equal(p.attr("VigentUser").fg, "#87af87");
	p.clear("Comment");
	assert.equal(p.attr("Comment").fg, "#bcbcbc");
	p.clear();
	assert.equal(p.attr("VigentUser").fg, "#ffffff"); // back to VigentUser -> Title
});

test("palette themes fill every group vigent draws", () => {
	const t = fromPalette("x", {
		bg: "#000000", fg: "#ffffff", red: "#ff0000", yellow: "#ffff00", green: "#00ff00",
		cyan: "#00ffff", blue: "#0000ff", magenta: "#ff00ff",
	});
	for (const g of ["Normal", "StatusLine", "CursorLine", "LineNr", "VigentSidebar", "VigentModeInsert", "FloatBorder", "PmenuSel"]) {
		assert.ok(t.groups[g], `missing ${g}`);
	}
	assert.equal(t.background, "dark");
	const light = fromPalette("l", { ...t.groups.Normal, bg: "#fafafa", fg: "#111111", red: "#c00", yellow: "#a80", green: "#080", cyan: "#088", blue: "#00c", magenta: "#a0a" });
	assert.equal(light.background, "light");
});

test("every built-in theme resolves the groups vigent uses", () => {
	for (const [name, theme] of Object.entries(BUILTIN_THEMES)) {
		const p = new Painter(theme);
		for (const g of ["Normal", "VigentSidebar", "VigentModeNormal", "CursorLine", "WinBar", "PmenuSel"]) {
			assert.ok(sgr(p.attr(g)).length > 0, `${name}: ${g} has no style`);
		}
	}
});

test("group values accept tables, :hi strings and link names", () => {
	assert.deepEqual(
		normalizeGroups({
			A: { fg: "#111111", bold: true },
			B: "guifg=#222222 guibg=NONE gui=italic,underline",
			C: "Visual",
			D: { link: "Comment" },
		}),
		{
			A: { fg: "#111111", bold: true },
			B: { fg: "#222222", bg: "NONE", italic: true, underline: true },
			C: { link: "Visual" },
			D: { link: "Comment" },
		},
	);
});

test("theme files: extends, palette, groups, legacy JSON and .vim", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-test-"));
	const old = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = dir;
	try {
		const themes = path.join(dir, "vigent", "themes");
		fs.mkdirSync(themes, { recursive: true });
		fs.writeFileSync(
			path.join(themes, "mine.toml"),
			'extends = "tokyonight"\n[groups]\nComment = { fg = "#123456" }\nCursorLineNr = "Title"\n',
		);
		fs.writeFileSync(path.join(themes, "legacy.json"), JSON.stringify({ Normal: { fg: "#010101", bg: "#020202" } }));
		fs.writeFileSync(path.join(themes, "old.vim"), "hi Normal guifg=#aaaaaa guibg=#000000\nlet g:colors_name = 'old'\n");

		const mine = loadTheme("mine");
		assert.equal(mine.name, "mine");
		assert.equal(mine.groups.Comment.fg, "#123456");
		assert.equal(mine.groups.Normal.bg, BUILTIN_THEMES.tokyonight.groups.Normal.bg);
		assert.deepEqual(mine.groups.CursorLineNr, { link: "Title" });

		assert.equal(loadTheme("legacy").groups.Normal.bg, "#020202");
		assert.equal(loadTheme("old").name, "old");
		assert.equal(loadTheme(path.join(themes, "old.vim")).groups.Normal.fg, "#aaaaaa");
		assert.throws(() => loadTheme("nope"), /E185/);
		assert.throws(() => buildTheme({ palette: { bg: "#000000" } }, "bad"), /palette is missing/);
		assert.throws(() => buildTheme({ extends: "loop" }, "loop"), /extends itself|E185/);
	} finally {
		if (old === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = old;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
