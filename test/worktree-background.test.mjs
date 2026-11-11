/**
 * A new agent's worktree is made in the background: the real `vigent` in a
 * pseudo-terminal, with a git whose `worktree add` waits until the test lets it
 * go, so vigent has to keep answering keys while a big checkout is copied.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { addWorktree, planWorktree } from "../dist/worktree.js";
import { Tty } from "./support/terminal.mjs";

const skip = process.platform === "win32" || spawnSync("python3", ["-c", "import pty"]).status !== 0 ? "needs python3 and a Unix pty" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-bgwt-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const identity = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const realGit = path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git");

function repo(name) {
	const root = path.join(tmp, name);
	fs.mkdirSync(root);
	const git = (...a) => execFileSync(realGit, a, { cwd: root, env: { ...process.env, ...identity }, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "init");
	return root;
}

test("planning a worktree makes nothing, and two plans for one name get two folders", async () => {
	const root = repo("plan");
	const config = { enabled: true, dir: "../{repo}-worktrees", branch: "{type}/{name}", backend: "git" };
	const a = planWorktree(root, "fix it", config);
	const b = planWorktree(root, "fix it", config);
	assert.equal(a.branch, "fix/it");
	assert.equal(b.branch, "fix/it-2", "the first one isn't made yet, but its name is taken");
	assert.equal(fs.existsSync(a.path), false);
	// both made at once: one at a time underneath, and both there
	const [ma, mb] = await Promise.all([addWorktree(root, a, config), addWorktree(root, b, config)]);
	assert.equal(fs.readFileSync(path.join(ma.path, "a.txt"), "utf8"), "one\n");
	assert.equal(fs.readFileSync(path.join(mb.path, "a.txt"), "utf8"), "one\n");
	await assert.rejects(addWorktree(root, { ...planWorktree(root, "docs x", config), base: "no-such-branch" }, config), /git worktree add failed/);
	assert.equal(planWorktree(root, "docs x", config).branch, "docs/x", "a worktree that failed gives its name back");
});

test("vigent answers keys while a new agent's worktree is made, and the prompt waits for it", { skip, timeout: 30000 }, async () => {
	const root = repo("app");
	const bin = path.join(tmp, "bin");
	const gate = path.join(tmp, "gate");
	const log = path.join(tmp, "claude.log");
	fs.mkdirSync(bin);
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	// `git worktree add` waits for the gate: a checkout that takes as long as the test wants
	fs.writeFileSync(
		path.join(bin, "git"),
		`#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(bin, "claude"),
		`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), prompt: args.at(-1) }) + "\\n");
const say = (o) => console.log(JSON.stringify(o));
say({ type: "system", subtype: "init", session_id: "s1", model: "m" });
say({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "DONE" }] } });
say({ type: "result", subtype: "success", is_error: false, session_id: "s1" });
`,
		{ mode: 0o755 },
	);
	const home = path.join(tmp, "home");
	fs.mkdirSync(path.join(home, ".config", "vigent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".config", "vigent", "config.toml"), 'engine = "claude"\n');
	const env = { ...identity, PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state"), TERM: "xterm-256color", LANG: "en_US.UTF-8", RIFTRI_BINARY: path.join(tmp, "no-riftri") };
	const t = new Tty([], { cwd: root, env, cols: 140, rows: 32 });
	try {
		await t.waitFor(/Claude Code/);
		await t.type(":new tidy the readme\r");
		await t.waitFor(/making its worktree/);
		await t.type("ihello there\r");
		// git is still copying: a key on the : line is answered all the same
		await t.type("\x1b:theme");
		await t.waitFor(/:theme/, 5000);
		await t.type("\x1b");
		assert.equal(fs.existsSync(log), false, "nothing runs before its worktree is there");
		const folder = path.join(tmp, "app-worktrees", "feat-tidy-the-readme");
		assert.equal(fs.existsSync(folder), false);

		fs.writeFileSync(gate, "");
		await t.waitFor(/DONE/, 15000);
		const [run] = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(run, { cwd: folder, prompt: "hello there" }, "the prompt that waited ran in the new worktree");
	} finally {
		t.kill();
	}
});
