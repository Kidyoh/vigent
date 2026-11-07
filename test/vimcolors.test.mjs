import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { resolveVimColor, xterm256 } from "../dist/color.js";
import { parseHighlightCommand, parseVimColorscheme } from "../dist/vimcolors.js";

test(":hi argument parsing", () => {
	assert.deepEqual(parseHighlightCommand("Normal guifg=#FFFFFF guibg=#333333").attr, { fg: "#ffffff", bg: "#333333" });
	// gui=NONE switches attributes off, so it can undo a theme's italics as an override
	assert.deepEqual(parseHighlightCommand("Comment gui=NONE").attr, {
		bold: false,
		italic: false,
		underline: false,
		reverse: false,
	});
	assert.deepEqual(parseHighlightCommand("Comment fg=#888888 italic").attr, { fg: "#888888", italic: true });
	assert.deepEqual(parseHighlightCommand("! default link Foo Bar"), { kind: "link", from: "Foo", to: "Bar" });
	assert.deepEqual(parseHighlightCommand("clear"), { kind: "clear", group: undefined });
	assert.deepEqual(parseHighlightCommand("Visual"), { kind: "show", group: "Visual" });
	assert.deepEqual(parseHighlightCommand("Title guifg='Light Blue' gui=bold,undercurl").attr, {
		fg: "#add8e6",
		bold: true,
		underline: true,
	});
	assert.equal(parseHighlightCommand(""), undefined);
});

test("color names, grayN and cterm fallbacks", () => {
	assert.equal(resolveVimColor("White"), "#ffffff");
	assert.equal(resolveVimColor("grey50"), "#808080");
	assert.equal(resolveVimColor("NONE"), "NONE");
	assert.equal(resolveVimColor("236", true), "#303030");
	assert.equal(resolveVimColor("DarkBlue", true), "#000080");
	assert.equal(xterm256(16), "#000000");
	assert.equal(xterm256(231), "#ffffff");
	assert.equal(xterm256(300), undefined);
	assert.deepEqual(parseHighlightCommand("X ctermfg=196 ctermbg=NONE").attr, { fg: "#ff0000", bg: "NONE" });
	// gui colors win over cterm ones
	assert.equal(parseHighlightCommand("X ctermfg=196 guifg=#00ff00").attr.fg, "#00ff00");
});

test("static colorscheme parsing: branches, finish, links", () => {
	const src = [
		'" comment',
		"set background=dark",
		"hi clear",
		"let g:colors_name = 'demo'",
		"if &background ==# 'light'",
		"  hi Normal guifg=#000000 guibg=#ffffff",
		"else",
		"  hi Normal guifg=#eeeeee guibg=#111111",
		"endif",
		"hi! link EndOfBuffer NonText",
		"hi NonText guifg=#444444",
		"hi Linked guifg=#123456",
		"hi link Linked Normal",
		"hi Comment",
		"  \\ guifg=#777777 gui=italic",
		"if s:t_Co >= 256",
		"  hi Comment ctermfg=244",
		"  finish",
		"endif",
		"hi Late guifg=#999999",
	].join("\n");
	const dark = parseVimColorscheme(src);
	assert.equal(dark.name, "demo");
	assert.equal(dark.background, "dark");
	assert.deepEqual(dark.groups.Normal, { fg: "#eeeeee", bg: "#111111" });
	assert.deepEqual(dark.groups.EndOfBuffer, { link: "NonText" });
	assert.deepEqual(dark.groups.Comment, { fg: "#777777", italic: true });
	assert.equal(dark.groups.Late, undefined, "lines after finish are ignored");
	assert.deepEqual(dark.groups.Linked, { fg: "#123456" }, "own colors beat a later default link");
	assert.deepEqual(parseVimColorscheme(src, "light").groups.Normal, { fg: "#000000", bg: "#ffffff" });
});

test("parses colorschemes shipped with vim", { skip: !fs.existsSync("/usr/share/vim/vim91/colors") }, () => {
	const dir = "/usr/share/vim/vim91/colors";
	for (const name of ["desert", "habamax", "slate", "lunaperche", "retrobox"]) {
		const file = `${dir}/${name}.vim`;
		if (!fs.existsSync(file)) continue;
		const parsed = parseVimColorscheme(fs.readFileSync(file, "utf8"));
		assert.equal(parsed.name, name);
		assert.ok(parsed.groups.Normal?.fg, `${name}: Normal has no fg`);
		assert.ok(Object.keys(parsed.groups).length > 40, `${name}: too few groups`);
	}
});
