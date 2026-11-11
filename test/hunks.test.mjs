import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { dropPatch, parseDiff, patchFor, restorePatch } from "../dist/hunks.js";
import { Keymap } from "../dist/keys.js";
import { commitPending } from "../dist/review.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-hunks-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const until = async (fn, ms = 5000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};

/** a repo, and an agent's worktree with: a committed change, an uncommitted one in the same file, and a new file */
function setup(name) {
	const repo = path.join(tmp, name);
	fs.mkdirSync(repo);
	git(["init", "-q", "-b", "main"], repo);
	// commitPending runs git with the process's own env: CI has no identity of its own
	git(["config", "user.name", "T"], repo);
	git(["config", "user.email", "t@e.com"], repo);
	fs.writeFileSync(path.join(repo, "cart.js"), `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
	git(["add", "-A"], repo);
	git(["commit", "-qm", "base"], repo);
	const wt = path.join(tmp, `${name}-wt`);
	git(["worktree", "add", "-q", "-b", "fix/cart", wt, "main"], repo);
	const cart = path.join(wt, "cart.js");
	fs.writeFileSync(cart, fs.readFileSync(cart, "utf8").replace("line 3\n", "line three\n"));
	git(["commit", "-qam", "agent: committed change"], wt);
	fs.writeFileSync(cart, fs.readFileSync(cart, "utf8").replace("line 25\n", "line twenty-five\n"));
	fs.writeFileSync(path.join(wt, "notes.md"), "# notes\nkeep?\n");
	return { repo, wt, cart };
}

test("parse a diff into files and hunks; a one-hunk patch drops and restores just that change", async () => {
	const { wt, cart } = setup("unit");
	let text = git(["diff", "--no-color", "main"], wt);
	const files = parseDiff(text);
	assert.deepEqual(files.map((f) => [f.path, f.hunks.length]), [["cart.js", 2]]);
	assert.match(files[0].hunks[0].header, /^@@ -1,6 \+1,6 @@/);
	const second = patchFor(files[0], [files[0].hunks[1]]);
	assert.match(second, /^diff --git a\/cart\.js b\/cart\.js\n/);
	assert.doesNotMatch(second, /line three/, "only that hunk");

	await dropPatch(wt, second);
	assert.match(fs.readFileSync(cart, "utf8"), /^line 25$/m);
	assert.match(fs.readFileSync(cart, "utf8"), /^line three$/m, "the other hunk stays");
	await restorePatch(wt, second);
	assert.match(fs.readFileSync(cart, "utf8"), /^line twenty-five$/m);
	await assert.rejects(restorePatch(wt, second), /patch failed|patch does not apply|already exists/, "applying twice is refused, not doubled");
	text = "diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n";
	assert.deepEqual(parseDiff(text).map((f) => [f.path, f.binary, f.hunks.length]), [["x.png", true, 0]]);
});

test(":review: drop a hunk, drop a new file, undo, and :merge's commit leaves out what was dropped", async () => {
	const { repo, wt, cart } = setup("app");
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root: repo,
		config: { enabled: true, dir: "../{repo}-wt", branch: "{type}/{name}", backend: "git" },
	});
	class S extends Session {
		send() {}
		abort() {}
	}
	app.addSession(new S("fix cart", "m", { branch: "fix/cart", path: wt, base: "main" }), true);
	[" ", "r"].forEach((k) => app.handleInput(k)); // <leader>r
	await until(() => overlays.length === 1);
	const review = overlays[0];
	let screen = plain(review.render(110));
	assert.match(screen, /Review fix\/cart vs main · 3 hunks left/);
	assert.match(screen, /cart\.js {2}2 hunks/);
	assert.match(screen, /notes\.md {2}1 hunk/);
	assert.match(screen, /▌ @@ -1,6 \+1,6 @@/, "the first hunk is selected");
	assert.match(screen, /\+line three/);

	review.handleInput("j"); // the uncommitted change
	review.handleInput("x");
	await until(() => plain(review.render(110)).includes("2 hunks left"));
	screen = plain(review.render(110));
	assert.match(screen, /dropped hunk 2 of cart\.js · u undoes/);
	assert.match(screen, /1 dropped/);
	assert.match(fs.readFileSync(cart, "utf8"), /^line 25$/m);

	review.handleInput("J"); // to notes.md
	review.handleInput("X");
	// done once the review says so (it reloads the diff after git drops the file)
	await until(() => plain(review.render(110)).includes("dropped notes.md"));
	assert.ok(!fs.existsSync(path.join(wt, "notes.md")));
	review.handleInput("u");
	// the message comes after the diff reloads, which is after git writes the file back
	await until(() => plain(review.render(110)).includes("restored notes.md"));
	assert.ok(fs.existsSync(path.join(wt, "notes.md")));

	// what :merge would take: commit what's left in the worktree
	await commitPending({ branch: "fix/cart", path: wt, base: "main" });
	const merged = git(["diff", "main", "fix/cart"], repo);
	assert.match(merged, /\+line three/);
	assert.match(merged, /notes\.md/);
	assert.doesNotMatch(merged, /twenty-five/, "the dropped hunk isn't in the branch");

	review.handleInput("q");
	app.addSession(new S("busy", "m", { branch: "fix/cart", path: wt, base: "main" }), true);
	app.focusedSession.setState("running");
	[":", ..."review", "\r"].forEach((k) => app.handleInput(k));
	assert.match(app.message, /still working; review it when it's done/);
});
