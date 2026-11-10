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
import { CliSession, claudeAdapter, codexAdapter, lastClaudeMessage } from "../dist/cli-engines.js";
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
	const at = claudeAdapter.args("hi", { cwd: "/x", resumeId: "abc", fork: true, forkAt: "m-7" });
	assert.deepEqual(at.slice(at.indexOf("--resume"), -2), ["--resume", "abc", "--fork-session", "--resume-session-at", "m-7"], "Claude Code forks at the split's last message");
	assert.deepEqual(codexAdapter.forkArgs({ cwd: "/x", resumeId: "abc" }).slice(0, 2), ["exec", "fork"]);
	assert.equal(codexAdapter.forkArgs({ cwd: "/x", resumeId: "abc" }).at(-1), "abc", "Codex forks right away, with no prompt");
});

test("the last message of a conversation Claude Code saved, for agents reopened after a restart", () => {
	const dir = path.join(tmp, "claude-config");
	const cwd = "/work/shop.git/feat_x";
	fs.mkdirSync(path.join(dir, "projects", "-work-shop-git-feat-x"), { recursive: true });
	const lines = [
		{ type: "user", uuid: "u1" },
		{ type: "assistant", uuid: "a1" },
		{ type: "assistant", uuid: "side", isSidechain: true },
		{ type: "assistant", uuid: "a2" },
		{ type: "last-prompt", leafUuid: "a2" },
	];
	fs.writeFileSync(path.join(dir, "projects", "-work-shop-git-feat-x", "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
	assert.equal(lastClaudeMessage(cwd, "s1", dir), "a2");
	assert.equal(lastClaudeMessage(cwd, "missing", dir), undefined);
});

/** A stand-in codex: `exec fork <id>` with no prompt makes a thread; everything is logged. */
function fakeCodex(name, { forkFails = false } = {}) {
	const bin = path.join(tmp, name);
	const log = path.join(tmp, `${name}.log`);
	fs.writeFileSync(
		bin,
		`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const say = (o) => console.log(JSON.stringify(o));
if (args[1] === "fork" && !args.includes("--")) {
	if (${forkFails}) { console.error("error: thread not found"); process.exit(1); }
	say({ type: "thread.started", thread_id: "forked-thread" });
	process.exit(0);
}
const id = args[1] === "resume" ? args[args.indexOf("--") - 1] : "new-thread";
say({ type: "thread.started", thread_id: id });
say({ type: "item.completed", item: { type: "agent_message", text: "reply" } });
say({ type: "turn.completed", usage: {} });
`,
		{ mode: 0o755 },
	);
	return { bin, calls: () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) };
}

const settled = (s) => new Promise((resolve) => {
	const check = () => (s.state === "running" ? setTimeout(check, 10) : resolve());
	check();
});

test("a Codex fork is made when you split, so what the original is told afterwards never reaches it", { skip: process.platform === "win32" && "a script as a binary", timeout: 20000 }, async () => {
	const { bin, calls } = fakeCodex("codex-ok");
	const ids = [];
	const fork = new CliSession("f", "codex", undefined, { cwd: tmp, resumeId: "original-thread", fork: true, bin, onResumeId: (id) => ids.push(id) });
	fork.send("only for the fork");
	assert.equal(fork.state, "running", "the prompt waits for the fork");
	await settled(fork);
	const [made, ran] = calls();
	assert.deepEqual(made.slice(0, 2), ["exec", "fork"]);
	assert.equal(made.at(-1), "original-thread");
	assert.ok(!made.includes("only for the fork"), "forked with no prompt");
	assert.deepEqual(ran.slice(0, 2), ["exec", "resume"], "then it's a conversation of its own");
	assert.deepEqual(ran.slice(-3), ["forked-thread", "--", "only for the fork"]);
	assert.deepEqual(ids, ["forked-thread"]);
	assert.equal(fork.resumeId, "forked-thread");
});

test("a fork that couldn't be made says so, and never forks later instead", { skip: process.platform === "win32" && "a script as a binary", timeout: 20000 }, async () => {
	const { bin, calls } = fakeCodex("codex-broken", { forkFails: true });
	const fork = new CliSession("f", "codex", undefined, { cwd: tmp, resumeId: "gone", fork: true, bin });
	fork.send("hello");
	await settled(fork);
	assert.equal(fork.state, "error");
	assert.match(fork.items.at(-1).text, /couldn't fork the Codex conversation: error: thread not found\. Close this window \(:q\) and split again/);
	assert.equal(calls().length, 1, "nothing ran after the failed fork");
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
// like Claude Code: --resume keeps the conversation's id, --fork-session makes a new one
const r = args.indexOf("--resume");
const id = r >= 0 && !args.includes("--fork-session") ? args[r + 1] : "session-" + n;
const say = (o) => console.log(JSON.stringify(o));
say({ type: "system", subtype: "init", session_id: id, model: "m" });
say({ type: "assistant", session_id: id, uuid: "msg-" + n, message: { content: [{ type: "text", text: "reply " + n }] } });
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
		// the original first: what it's told after the split must stay out of the fork
		await t.type("\x17");
		await t.type("h");
		await t.type("i");
		await t.type("only the original\r");
		await t.waitFor(/reply 1/);
		await t.type("\x17");
		await t.type("l");
		await t.type("i");
		await t.type("something else\r");
		await t.waitFor(/reply 2/);
		await t.type("i");
		await t.type("and more\r");
		await t.waitFor(/reply 3/);

		const [first, original, forked, next] = calls();
		assert.deepEqual(original.args.slice(original.args.indexOf("--resume"), -2), ["--resume", "session-0"], "the original carries on in its own conversation");
		assert.deepEqual(forked.args.slice(forked.args.indexOf("--resume"), -2), ["--resume", "session-0", "--fork-session", "--resume-session-at", "msg-0"], "forked where the split was, not after the original's next turn");
		assert.equal(forked.cwd, first.cwd, "same worktree: the conversation's paths still point at real files");
		assert.deepEqual(next.args.slice(next.args.indexOf("--resume"), -2), ["--resume", "session-2"], "forked once, then its own conversation");
		assert.equal(loadAgentMeta(first.cwd).resumeId, "session-0", "the original's saved conversation is still its own");
	} finally {
		t.kill();
	}
});
