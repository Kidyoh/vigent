import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { expandPrompt, listFiles, MAX_INLINE_BYTES, mentionable, mentions } from "../dist/attach.js";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-attach-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** a small repo: tracked, new and ignored files */
function repo() {
	const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
	const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
	git("init", "-q");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "cart.js"), "export const total = (items) => items.length;\n");
	fs.writeFileSync(path.join(dir, "README.md"), "# shop\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "secret.env\n");
	fs.writeFileSync(path.join(dir, "secret.env"), "TOKEN=x\n");
	git("add", ".");
	fs.writeFileSync(path.join(dir, "notes.txt"), "remember the race");
	fs.writeFileSync(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
	fs.writeFileSync(path.join(dir, "big.log"), "x".repeat(MAX_INLINE_BYTES + 10));
	return dir;
}

test("the files you can attach: tracked and new, not what .gitignore hides; shallow ones first", async () => {
	const dir = repo();
	const files = await listFiles(dir);
	assert.deepEqual(files, [".gitignore", "big.log", "logo.png", "notes.txt", "README.md", "src/cart.js"]);
	// not a repository: a walk that skips the heavy folders
	const plainDir = fs.mkdtempSync(path.join(tmp, "plain-"));
	fs.mkdirSync(path.join(plainDir, "node_modules", "x"), { recursive: true });
	fs.writeFileSync(path.join(plainDir, "node_modules", "x", "i.js"), "");
	fs.writeFileSync(path.join(plainDir, "a.txt"), "");
	assert.deepEqual(await listFiles(plainDir), ["a.txt"]);
});

test("@mentions: files inside the agent's folder, once each, not emails or paths outside", () => {
	const dir = repo();
	assert.deepEqual(mentions("look at @src/cart.js and @README.md, then @src/cart.js again", dir), ["src/cart.js", "README.md"]);
	assert.deepEqual(mentions("mail me@example.com about @missing.ts or @../etc/passwd", dir), []);
	assert.deepEqual(mentions("@notes.txt.", dir), ["notes.txt"], "a full stop after it isn't part of the name");
	fs.writeFileSync(path.join(dir, "café.md"), "menu\n");
	assert.deepEqual(mentions("(@café.md)", dir), [], "only at the start of a word");
	assert.deepEqual(mentions("see @café.md", dir), ["café.md"], "names in any script");
	assert.equal(mentionable("café.md"), true);
	assert.equal(mentionable("my notes.txt"), false, "a space would end the mention: the picker leaves it out");
});

test("each engine gets the files its own way", () => {
	const dir = repo();
	const prompt = "fix @src/cart.js, see @notes.txt";
	assert.deepEqual(expandPrompt(prompt, "claude", dir), { prompt, files: [], skipped: [] }, "Claude Code reads @path itself");
	const oc = expandPrompt(prompt, "opencode", dir);
	assert.equal(oc.prompt, prompt);
	assert.deepEqual(oc.files, [path.join(dir, "src/cart.js"), path.join(dir, "notes.txt")]);
	assert.deepEqual(CLI_ADAPTERS.opencode.args(prompt, { cwd: dir, files: oc.files }).slice(-6), ["-f", oc.files[0], "-f", oc.files[1], "--", prompt]);
	for (const engine of ["codex", "pi"]) {
		const ex = expandPrompt(prompt, engine, dir);
		assert.equal(
			ex.prompt,
			`${prompt}\n\nAttached files:\n\n<file path="src/cart.js">\nexport const total = (items) => items.length;\n</file>\n\n<file path="notes.txt">\nremember the race\n</file>`,
		);
	}
	const skipped = expandPrompt("@logo.png @big.log", "codex", dir);
	assert.equal(skipped.prompt, "@logo.png @big.log", "nothing to add: the prompt is what you typed");
	assert.deepEqual(skipped.skipped, ["logo.png (binary)", "big.log (100 KB, over 100 KB)"]);
	assert.deepEqual(expandPrompt("no mentions here", "codex", dir).prompt, "no mentions here");
});

test("typing @ in insert mode opens a file picker; Enter writes @path, Esc keeps @, Backspace takes it back", async () => {
	const dir = repo();
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide: () => overlays.splice(overlays.indexOf(c), 1) }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, termguicolors: true }, new Keymap());
	const s = new CliSession("racer", "claude", undefined, { cwd: dir, bin: "/bin/true" });
	app.addSession(s, true);
	const type = (text) => [...text].forEach((k) => app.handleInput(k));

	app.handleInput("i");
	type("fix ");
	type("@");
	assert.equal(overlays.length, 1);
	// the list comes from a git process, which takes as long as it takes
	for (let i = 0; i < 250 && plain(overlays[0].render(70)).includes("loading…"); i++) await tick();
	let screen = plain(overlays[0].render(70));
	assert.match(screen, /Attach a file/);
	assert.match(screen, /src\/cart\.js/);
	assert.doesNotMatch(screen, /secret\.env/, "what .gitignore hides isn't offered");
	const pick = (keys) => [...keys].forEach((k) => overlays[0].handleInput(k)); // the overlay has the keyboard
	pick("cart");
	screen = plain(overlays[0].render(70));
	assert.match(screen, /cart/, "typing filters right away");
	assert.match(screen, /1\/1/);
	pick("\r");
	assert.equal(overlays.length, 0);
	assert.equal(app.inputBuf, "fix @src/cart.js ");

	type("@");
	await tick();
	pick("\x1b\x1b"); // a literal @ (the first Esc ends the search)
	assert.equal(overlays.length, 0);
	assert.equal(app.inputBuf, "fix @src/cart.js @");

	type(" ");
	type("@");
	await tick();
	pick("\x7f"); // Backspace: no @ after all
	assert.equal(overlays.length, 0);
	assert.equal(app.inputBuf, "fix @src/cart.js @ ");

	type("me@x.com");
	assert.equal(overlays.length, 0, "an @ inside a word isn't a mention");
});

test("a Codex agent gets the file's contents; the transcript shows what you typed, @path highlighted", async () => {
	const dir = repo();
	const log = path.join(tmp, "codex-argv.json");
	const bin = path.join(tmp, "codex");
	fs.writeFileSync(bin, `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
	fs.chmodSync(bin, 0o755);
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, termguicolors: true }, new Keymap());
	const s = new CliSession("racer", "codex", undefined, { cwd: dir, bin });
	app.addSession(s, true);
	s.send("why is @src/cart.js wrong? also @logo.png");
	for (let i = 0; i < 100 && s.state === "running"; i++) await tick();
	const argv = JSON.parse(fs.readFileSync(log, "utf8"));
	const prompt = argv.at(-1);
	assert.match(prompt, /^why is @src\/cart\.js wrong\? also @logo\.png\n\nAttached files:\n\n<file path="src\/cart\.js">\nexport const total/);
	const screen = app.render(120).join("\n");
	assert.match(plain([screen]), /why is @src\/cart\.js wrong\? also @logo\.png/);
	assert.doesNotMatch(plain([screen]), /Attached files/, "the transcript shows what you typed");
	assert.match(plain([screen]), /not attached: logo\.png \(binary\)/);
	const special = new Painter(BUILTIN_THEMES.default).s("VigentMention");
	assert.ok(screen.includes(`${special}@src/cart.js`), "the mention is highlighted");
});
