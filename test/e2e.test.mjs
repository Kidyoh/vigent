/**
 * End to end: the real `vigent` command in a pseudo-terminal, in a real git
 * repository, with a stand-in `claude` CLI on PATH that answers like Claude
 * Code does (captured output). Everything a user does, nothing mocked inside
 * vigent: start, see the engines, press i, type a task, Enter, watch the agent
 * work in its own worktree, follow up, switch themes, quit, restart.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { CLI, Tty } from "./support/terminal.mjs";

const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;
const skip = process.platform === "win32" || !hasPython ? "needs python3 and a Unix pty" : false;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-e2e-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fixture = path.join(import.meta.dirname, "fixtures", "claude-tool.jsonl");
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitDir = path.dirname(execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split("\n")[0].trim());

// a stand-in `claude`: version, sign-in status, and a run that edits a file and streams Claude Code's JSON
const bin = path.join(tmp, "bin");
const claudeLog = path.join(tmp, "claude-calls.log");
fs.mkdirSync(bin);
fs.writeFileSync(
	path.join(bin, "claude"),
	`#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
if (args.join(" ") === "auth status --json") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
fs.writeFileSync("hello.txt", "hi\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
`,
);
fs.chmodSync(path.join(bin, "claude"), 0o755);

// node and git only, so agent CLIs installed on this machine don't leak in
const sys = path.join(tmp, "sysbin");
fs.mkdirSync(sys);
fs.symlinkSync(process.execPath, path.join(sys, "node"));
fs.symlinkSync(path.join(gitDir, "git"), path.join(sys, "git"));

const home = path.join(tmp, "home");
fs.mkdirSync(home);
// only what a fresh machine has: no API keys, no real agent CLIs, git and node
const env = {
	PATH: [bin, sys].join(path.delimiter),
	HOME: home,
	XDG_CONFIG_HOME: path.join(home, ".config"),
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
	GIT_AUTHOR_NAME: "T",
	GIT_AUTHOR_EMAIL: "t@e.com",
	GIT_COMMITTER_NAME: "T",
	GIT_COMMITTER_EMAIL: "t@e.com",
	// worktrees with plain git here; riftri has its own tests
	RIFTRI_BINARY: path.join(tmp, "no-riftri"),
};

const repo = path.join(tmp, "shop");
fs.mkdirSync(repo);
git(["init", "-q", "-b", "main"], repo);
fs.writeFileSync(path.join(repo, "README.md"), "# shop\n");
execFileSync("git", ["add", "-A"], { cwd: repo });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repo, env: { ...process.env, ...env } });

test("vigent --version and theme list (the commands to check an install)", { skip }, () => {
	const version = execFileSync(process.execPath, [CLI, "--version"], { env, encoding: "utf8" }).trim();
	const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.match(version, new RegExp(`^vigent ${pkg.version.replace(/\./g, "\\.")}( \\([0-9a-f]+\\))?$`));
	const themes = execFileSync(process.execPath, [CLI, "theme", "list"], { env, encoding: "utf8" });
	for (const t of ["lazyvim", "tokyonight-moon", "default"]) assert.match(themes, new RegExp(`^${t}\\b`, "m"));
});

test("first run: i, a task, Enter starts an agent on Claude Code in its own worktree; it works, follows up, and comes back after a restart", { skip, timeout: 120000 }, async () => {
	const t = new Tty([], { cwd: repo, env });
	try {
		await t.waitFor(/vigent \d+\.\d+\.\d+.* themes/);
		await t.waitFor(/● Claude Code +default/);

		// the intro tells you what to do
		assert.match(t.screen(), /New agent: type a task, Enter +i/);
		assert.match(t.screen(), /██╗   ██╗██╗ ██████╗/, "LazyVim-style logo");

		await t.type("i");
		await t.waitFor("Enter starts an agent on Claude Code");
		await t.type("write a hello file\r");

		// the agent runs: Claude Code's tool call and reply show up
		await t.waitFor(/▸ Write/);
		await t.waitFor(/│ done\s*$/m);
		const screen = await t.waitFor(/write hello file/);
		assert.match(screen, /❯ write a hello file/);
		assert.match(screen, /Claude Code · claude-fable-5/, "the winbar names the engine and the model Claude Code reported");

		// in its own worktree and branch, not your checkout
		const worktree = path.join(tmp, "shop-worktrees", "feat-write-hello-file");
		assert.ok(fs.existsSync(path.join(worktree, "hello.txt")), "the agent's edit is in its worktree");
		assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "your checkout is untouched");
		assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], worktree), "feat/write-hello-file");
		await t.waitFor(/\+1/); // the sidebar counts the new file

		// follow up: same conversation (--resume with the id Claude Code printed)
		await t.type("i");
		await t.type("now say bye\r");
		await t.waitFor("❯ now say bye");
		const calls = () => fs.readFileSync(claudeLog, "utf8").trim().split("\n").map(JSON.parse);
		const until = Date.now() + 10000;
		while (calls().length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
		const [first, second] = calls();
		assert.equal(fs.realpathSync(first.cwd), fs.realpathSync(worktree));
		assert.ok(!first.args.includes("--resume"));
		assert.deepEqual(second.args.slice(-4), ["--resume", "3b248a3e-43fd-4fd1-98b5-f36e06e02d85", "--", "now say bye"]);

		// themes, including lazyvim
		await t.ex("colorscheme lazyvim");
		await t.waitFor("colorscheme lazyvim");
		assert.doesNotMatch(t.screen(), /E185/);
		await t.ex("checkhealth");
		await t.waitFor(/Claude Code {2}2\.1\.319 {2}\(default for :new\)/);
		await t.type("q");

		// effort and model, picked while it runs, reach Claude Code on the next prompt
		await t.ex("effort high");
		await t.waitFor(/effort for 'write hello file' \(Claude Code\): high/);
		await t.ex("model opus");
		await t.waitFor(/opus · high/);
		await t.type("i");
		await t.type("third\r");
		const until3 = Date.now() + 10000;
		while (calls().length < 3 && Date.now() < until3) await new Promise((r) => setTimeout(r, 100));
		const third = calls()[2].args;
		assert.deepEqual(third.slice(third.indexOf("--model"), third.indexOf("--model") + 4), ["--model", "opus", "--effort", "high"]);
		await t.waitFor(/│ done\s*$/m);

		await t.ex("q");
		assert.equal(await t.exited, 0);
	} finally {
		t.kill();
	}

	// restart: the agent is back
	const again = new Tty([], { cwd: repo, env });
	try {
		await again.waitFor(/reopened 1 agent from last time/);
		await again.waitFor(/write hello file/);
		await again.waitFor(/continuing the Claude Code conversation 3b248a3e/);
		await again.ex("q");
		assert.equal(await again.exited, 0);
	} finally {
		again.kill();
	}

	// `vigent <folder>` from somewhere else opens that project, like `vigent .` inside it
	const fromOutside = new Tty([repo], { cwd: tmp, env });
	try {
		await fromOutside.waitFor(/reopened 1 agent from last time/);
		await fromOutside.waitFor(/write hello file/);
		await fromOutside.ex("q");
		assert.equal(await fromOutside.exited, 0);
	} finally {
		fromOutside.kill();
	}
});

test("vigent <folder> that isn't a folder says so", () => {
	const r = spawnSync(process.execPath, [CLI, path.join(os.tmpdir(), "no-such-vigent-folder")], { env, encoding: "utf8" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /is not a folder \(usage: vigent \[folder\]\)/);
});

test("no agent CLI and no API key: the demo starts, and says so", { skip, timeout: 60000 }, async () => {
	const plainEnv = { ...env, PATH: sys };
	const fresh = path.join(tmp, "empty-project");
	fs.mkdirSync(fresh);
	git(["init", "-q", "-b", "main"], fresh);
	const t = new Tty([], { cwd: fresh, env: plainEnv });
	try {
		await t.waitFor(/SESSIONS/);
		await t.waitFor(/demo mode: these agents are scripted/);
		assert.match(t.screen(), /NORMAL  DEMO/);
		await t.ex("q!");
		assert.equal(await t.exited, 0);
	} finally {
		t.kill();
	}
});

// Installed the way a user gets it: the npm package, into a fresh prefix, run as `vigent`.
// Packs the dist/ npm test just built (prepack would rebuild it under the other test files).
const online = spawnSync("npm", ["ping"], { stdio: "ignore", timeout: 15000 }).status === 0;
test("the packed npm package installs and runs as `vigent`", { skip: skip || (!online && "needs the npm registry"), timeout: 600000 }, () => {
	const root = path.join(import.meta.dirname, "..");
	const out = path.join(tmp, "pack");
	fs.mkdirSync(out);
	const tgz = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", out], { cwd: root, encoding: "utf8" }).trim().split("\n").pop();
	const prefix = path.join(tmp, "prefix");
	execFileSync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", path.join(out, tgz)], { stdio: "ignore" });
	const vigent = path.join(prefix, "bin", "vigent");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	assert.equal(execFileSync(vigent, ["--version"], { env, encoding: "utf8" }).trim(), `vigent ${pkg.version}`, "no commit: it's not a clone");
	assert.match(execFileSync(vigent, ["theme", "list"], { env, encoding: "utf8" }), /^lazyvim\b/m);
	assert.match(execFileSync(vigent, ["--help"], { env, encoding: "utf8" }), /engines \(what runs new agents/);
});
