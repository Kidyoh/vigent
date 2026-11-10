/**
 * Forking for real: the `vigent` command in a pseudo-terminal, with a stand-in
 * Claude Code that logs how it's called.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { loadAgentMeta } from "../dist/agents.js";
import { claudeAdapter, codexAdapter } from "../dist/cli-engines.js";
import { Tty } from "./support/terminal.mjs";

const skip = process.platform === "win32" || spawnSync("python3", ["-c", "import pty"]).status !== 0 ? "needs python3 and a Unix pty" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-fork-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("how each engine is asked to fork", () => {
	const claude = claudeAdapter.args("hi", { cwd: "/x", resumeId: "abc", fork: true });
	assert.deepEqual(claude.slice(claude.indexOf("--resume")), ["--resume", "abc", "--fork-session", "--", "hi"]);
	assert.ok(!claudeAdapter.args("hi", { cwd: "/x", resumeId: "abc" }).includes("--fork-session"));
	const codex = codexAdapter.args("hi", { cwd: "/x", resumeId: "abc", fork: true });
	assert.deepEqual(codex.slice(0, 2), ["exec", "fork"]);
	assert.deepEqual(codex.slice(-3), ["abc", "--", "hi"]);
	assert.equal(codexAdapter.args("hi", { cwd: "/x", resumeId: "abc" })[1], "resume");
});

test("a split forks once: the fork runs in the same folder, keeps its own id, and never touches the original's record", { skip, timeout: 60000 }, async () => {
	const bin = path.join(tmp, "bin");
	const home = path.join(tmp, "home");
	const repo = path.join(tmp, "shop");
	const log = path.join(tmp, "calls.log");
	fs.mkdirSync(bin);
	fs.mkdirSync(home);
	fs.mkdirSync(repo);
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	fs.symlinkSync(path.join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git"), path.join(bin, "git"));
	fs.writeFileSync(
		path.join(bin, "claude"),
		`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const n = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length : 0;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const id = "session-" + n;
const say = (o) => console.log(JSON.stringify(o));
say({ type: "system", subtype: "init", session_id: id, model: "m" });
say({ type: "assistant", session_id: id, message: { content: [{ type: "text", text: "reply " + n }] } });
say({ type: "result", subtype: "success", session_id: id, is_error: false, result: "reply " + n });
`,
		{ mode: 0o755 },
	);
	const identity = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" };
	const env = { ...identity, PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), TERM: "xterm-256color", LANG: "en_US.UTF-8", RIFTRI_BINARY: path.join(tmp, "no-riftri") };
	const git = (...a) => execFileSync("git", a, { cwd: repo, env: { ...process.env, ...identity }, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.js"), "1\n");
	git("add", "a.js");
	git("commit", "-qm", "init");

	const calls = () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
	const t = new Tty([], { cwd: repo, env });
	try {
		await t.waitFor(/● Claude Code +default/);
		await t.type("i");
		await t.type("first task\r");
		await t.waitFor(/reply 0/);
		await t.type("\x17");
		await t.type("v");
		await t.waitFor(/\(fork\)/);
		await t.type("i");
		await t.type("something else\r");
		await t.waitFor(/reply 1/);
		await t.type("i");
		await t.type("and more\r");
		await t.waitFor(/reply 2/);

		const [first, forked, next] = calls();
		assert.deepEqual(forked.args.slice(forked.args.indexOf("--resume"), -2), ["--resume", "session-0", "--fork-session"]);
		assert.equal(forked.cwd, first.cwd, "same worktree: the conversation's paths still point at real files");
		assert.deepEqual(next.args.slice(next.args.indexOf("--resume"), -2), ["--resume", "session-1"], "forked once, then its own conversation");
		assert.equal(loadAgentMeta(first.cwd).resumeId, "session-0", "the original's saved conversation is still its own");
	} finally {
		t.kill();
	}
});
