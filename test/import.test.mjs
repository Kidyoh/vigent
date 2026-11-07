import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { hasEditor, importTheme, parseHighlightListing } from "../dist/import.js";

const nvim = hasEditor("nvim");
const vim = hasEditor("vim");
let tmp;
const saved = {};

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-import-"));
	// a fake user config: nvim and vim both default to "desert"
	for (const key of ["HOME", "XDG_CONFIG_HOME"]) saved[key] = process.env[key];
	process.env.HOME = tmp;
	process.env.XDG_CONFIG_HOME = path.join(tmp, ".config");
	fs.mkdirSync(path.join(tmp, ".config", "nvim"), { recursive: true });
	fs.writeFileSync(path.join(tmp, ".config", "nvim", "init.lua"), 'vim.cmd.colorscheme("desert")\n');
	fs.writeFileSync(path.join(tmp, ".vimrc"), "colorscheme desert\n");
});

after(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("nvim: import a colorscheme by name", { skip: !nvim }, () => {
	const r = importTheme({ source: "habamax", outDir: tmp, editor: "nvim" });
	assert.equal(r.name, "habamax");
	assert.match(r.via, /^nvim/);
	const t = read(r.file);
	assert.equal(t.groups.Normal.bg, "#1c1c1c");
	assert.ok(r.groups > 100);
});

test("nvim: import the colorscheme the user's config sets", { skip: !nvim }, () => {
	const r = importTheme({ outDir: tmp, editor: "nvim" });
	assert.equal(r.name, "desert");
	assert.equal(r.via, "nvim");
	assert.equal(read(r.file).groups.Normal.bg, "#333333");
});

test("nvim: import a colorscheme file by path, with --as", { skip: !nvim }, () => {
	const file = path.join(tmp, "tiny.vim");
	fs.writeFileSync(file, "hi clear\nlet g:colors_name = 'tiny'\nhi Normal guifg=#abcdef guibg=#010203\n");
	const r = importTheme({ source: file, as: "mytiny", outDir: tmp, editor: "nvim" });
	assert.equal(r.name, "mytiny");
	assert.deepEqual(read(r.file).groups.Normal, { fg: "#abcdef", bg: "#010203" });
});

test("vim: import a colorscheme by name", { skip: !vim }, () => {
	const r = importTheme({ source: "retrobox", outDir: tmp, editor: "vim", background: "light" });
	assert.equal(r.name, "retrobox");
	assert.match(r.via, /^vim/);
	assert.equal(read(r.file).background, "light");
	assert.ok(read(r.file).groups.Normal.bg);
});

test("vim: import the colorscheme the user's vimrc sets", { skip: !vim }, () => {
	const r = importTheme({ outDir: tmp, editor: "vim" });
	assert.equal(r.name, "desert");
	assert.equal(read(r.file).groups.Normal.bg, "#333333");
});

test("a broken colorscheme file is an error, not the previous colorscheme", { skip: !nvim }, () => {
	// a lua colorscheme whose plugin isn't installed: it errors before setting its name
	const file = path.join(tmp, "broken.lua");
	fs.writeFileSync(file, 'require("not_installed_theme").setup()\nvim.g.colors_name = "broken"\n');
	assert.throws(() => importTheme({ source: file, outDir: tmp, editor: "nvim" }), /could not load/);
});

test("unknown colorscheme is an error, not a silent wrong import", { skip: !nvim && !vim }, () => {
	assert.throws(() => importTheme({ source: "definitely-not-a-theme", outDir: tmp }), /could not load/);
});

test("a .vim file imports without any editor", () => {
	const file = path.join(tmp, "static.vim");
	fs.writeFileSync(file, "let g:colors_name = 'static'\nhi Normal guifg=#111111 guibg=#eeeeee\n");
	const old = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		const r = importTheme({ source: file, outDir: tmp });
		assert.equal(r.via, "static parse");
		assert.equal(read(r.file).groups.Normal.bg, "#eeeeee");
	} finally {
		process.env.PATH = old;
	}
});

test("parses real :highlight listings from vim and nvim (fallback for old editors)", () => {
	for (const file of ["vim-highlight-desert.txt", "nvim-highlight-desert.txt"]) {
		const text = fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
		const groups = parseHighlightListing(text);
		assert.deepEqual(groups.Normal, { fg: "#ffffff", bg: "#333333" }, file);
		assert.deepEqual(groups.StatusLine, { fg: "#333333", bg: "#c2bfa5" }, file);
		assert.equal(groups.LineNr.fg, "#eeee00", file);
		assert.ok(Object.keys(groups).length > 40, file);
	}
	assert.deepEqual(parseHighlightListing(fs.readFileSync(new URL("./fixtures/nvim-highlight-desert.txt", import.meta.url), "utf8")).EndOfBuffer, { link: "NonText" });
});
