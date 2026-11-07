import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { followedColorscheme, followFile, followTheme, isFollow, refreshFollow } from "../dist/follow.js";
import { listThemes } from "../dist/theme.js";

const CLI = path.join(import.meta.dirname, "..", "dist", "cli.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-follow-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake nvim: prints a version, and for an import writes the dump vigent asks for,
// with the colorscheme named in $FAKE_SCHEME (as if your config set it).
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(
	path.join(bin, "nvim"),
	`#!${process.execPath}
if (process.argv.includes("--version")) { console.log("NVIM v0.11.0"); process.exit(0); }
const scheme = process.env.FAKE_SCHEME;
const bg = scheme === "astrodark" ? "#1a1d23" : "#222436";
require("fs").writeFileSync(process.env.VIGENT_OUT, JSON.stringify({
	name: scheme, background: "dark",
	groups: { Normal: { fg: "#c0caf5", bg }, Comment: { fg: "#636da6", italic: true }, String: { fg: "#c3e88d" } },
}));
`,
);
fs.chmodSync(path.join(bin, "nvim"), 0o755);
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");

test('theme = "nvim": imported the first time, then the copy is used', () => {
	assert.ok(isFollow("nvim") && isFollow("vim") && !isFollow("tokyonight"));
	process.env.FAKE_SCHEME = "astrodark";
	const theme = followTheme("nvim");
	assert.equal(theme.groups.Normal.bg, "#1a1d23");
	assert.equal(followedColorscheme("nvim"), "astrodark");
	assert.ok(fs.existsSync(followFile("nvim")));
	assert.ok(listThemes().includes("nvim"), ":colorscheme lists it");

	process.env.FAKE_SCHEME = "tokyonight-moon";
	assert.equal(followTheme("nvim").groups.Normal.bg, "#1a1d23", "no import at start once there's a copy");
});

test("the background import switches when the editor's colorscheme changed, and is quiet when it didn't", async () => {
	const run = () =>
		new Promise((resolve) => {
			let changed;
			refreshFollow("nvim", (t) => (changed = t), CLI);
			// the child import is quick; wait for it to finish
			const until = Date.now() + 10000;
			const poll = setInterval(() => {
				if (changed || Date.now() > until || fs.statSync(followFile("nvim")).mtimeMs > started) {
					setTimeout(() => (clearInterval(poll), resolve(changed)), 300);
				}
			}, 50);
			const started = fs.statSync(followFile("nvim")).mtimeMs;
		});

	process.env.FAKE_SCHEME = "tokyonight-moon";
	const t = await run();
	assert.ok(t, "a changed colorscheme reaches the app");
	assert.equal(t.groups.Normal.bg, "#222436");
	assert.equal(followedColorscheme("nvim"), "tokyonight-moon");

	assert.equal(await run(), undefined, "same colorscheme: no change, no message");
});
