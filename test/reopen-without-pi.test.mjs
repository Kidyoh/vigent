/**
 * Agents saved before vigent stopped bundling pi have no engine on record, so
 * they reopen on pi. Without pi they could never answer: the real `vigent`
 * command, in a pseudo-terminal, moves them to the engine you have.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { loadAgentMeta, saveAgentMeta, sessionDir } from "../dist/agents.js";
import { createWorktree } from "../dist/worktree.js";
import { Tty } from "./support/terminal.mjs";

const skip = process.platform === "win32" || spawnSync("python3", ["-c", "import pty"]).status !== 0 ? "needs python3 and a Unix pty" : false;

process.env.RIFTRI_BINARY = path.join(os.tmpdir(), "vigent-no-riftri");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-reopen-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fixture = path.join(import.meta.dirname, "fixtures", "claude-tool.jsonl");
const gitExec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" };

function machine(name, tools) {
	const root = path.join(tmp, name);
	const bin = path.join(root, "bin");
	const home = path.join(root, "home");
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(home);
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	fs.symlinkSync(path.join(gitExec, "git"), path.join(bin, "git"));
	const log = path.join(root, "claude-calls.log");
	if (tools.includes("claude")) {
		fs.writeFileSync(
			path.join(bin, "claude"),
			`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
`,
			{ mode: 0o755 },
		);
	}
	if (tools.includes("signed-out claude")) {
		fs.writeFileSync(
			path.join(bin, "claude"),
			// real sign-in checks are slow: this one still hasn't answered when a quick look would pick Claude Code
			`#!${process.execPath}
if (process.argv[2] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
setTimeout(() => { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }, 1500);
`,
			{ mode: 0o755 },
		);
	}
	if (tools.includes("codex")) {
		fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.1.0";; login) echo "Logged in using ChatGPT";; esac\n`, { mode: 0o755 });
	}
	if (tools.includes("pi")) fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });

	const repo = path.join(root, "shop");
	fs.mkdirSync(repo);
	const env = { ...GIT_IDENTITY, PATH: bin, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), TERM: "xterm-256color", LANG: "en_US.UTF-8", RIFTRI_BINARY: path.join(root, "no-riftri") };
	const git = (...args) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...GIT_IDENTITY }, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.js"), "1\n");
	git("add", "a.js");
	git("commit", "-qm", "init");

	const worktree = createWorktree(repo, "old agent");
	// what vigent 0.3 wrote for a pi agent: no engine, pi's model and thinking level
	saveAgentMeta(worktree.path, { name: "old agent", model: "claude-sonnet-4-5", base: "main", createdAt: "2026-11-07T09:19:38.968Z", effort: "xhigh" });
	const history = path.join(sessionDir(worktree.path), "conversation.jsonl");
	fs.mkdirSync(path.dirname(history), { recursive: true });
	fs.writeFileSync(history, "{}\n");
	return { repo, env, worktree: worktree.path, log, history };
}

test("without pi, an old agent reopens on the engine you have and answers", { skip, timeout: 60000 }, async () => {
	const m = machine("moved", ["claude"]);
	const t = new Tty([], { cwd: m.repo, env: m.env });
	try {
		await t.waitFor("reopened 1 agent");
		assert.doesNotMatch(t.screen(), /isn't installed, so|now runs on/, "the move happens without a note");
		const meta = loadAgentMeta(m.worktree);
		assert.equal(meta.engine, "claude", "the move is saved, so a resume id can't land on the wrong engine");
		assert.equal(meta.model, "", "pi's model isn't asked of another engine");
		assert.equal(meta.effort, undefined, "nor its thinking level");

		await t.type("i");
		await t.type("hello pls\r");
		await t.waitFor(/│ done\s*$/m);
		assert.doesNotMatch(t.screen(), /error: pi isn't installed/);
		const [call] = fs.readFileSync(m.log, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(m.worktree), "same worktree");
		assert.ok(!call.args.includes("claude-sonnet-4-5") && !call.args.includes("xhigh"));
		assert.ok(fs.existsSync(m.history), "pi's conversation stays where it was");
	} finally {
		t.kill();
	}
});

test("it moves to the engine that's signed in, not the first one that's installed", { skip, timeout: 60000 }, async () => {
	const m = machine("signed-in", ["signed-out claude", "codex"]);
	const t = new Tty([], { cwd: m.repo, env: m.env });
	try {
		await t.waitFor("reopened 1 agent");
		assert.equal(loadAgentMeta(m.worktree).engine, "codex");
	} finally {
		t.kill();
	}
});

test("with pi installed, an old agent stays on pi", { skip, timeout: 60000 }, async () => {
	const m = machine("kept", ["claude", "pi"]);
	const t = new Tty([], { cwd: m.repo, env: m.env });
	try {
		await t.waitFor("old agent");
		await t.waitFor("reopened 1 agent");
		assert.doesNotMatch(t.screen(), /now runs on/);
		assert.equal(loadAgentMeta(m.worktree).engine, undefined);
		assert.equal(loadAgentMeta(m.worktree).model, "claude-sonnet-4-5");
	} finally {
		t.kill();
	}
});

test("when pi is the engine you chose, the agent stays on pi and the hint says how to reach :new", { skip, timeout: 60000 }, async () => {
	const m = machine("stuck", ["claude"]);
	const t = new Tty(["--engine", "pi"], { cwd: m.repo, env: m.env });
	try {
		await t.waitFor(/press Esc/);
		assert.equal(loadAgentMeta(m.worktree).engine, undefined);
	} finally {
		t.kill();
	}
});
