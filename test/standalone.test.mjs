/**
 * The standalone binary (scripts/build-binary.mjs), run the way someone
 * without Node runs it: no `node` on PATH, riftri only beside the binary,
 * started through a symlink like the installer makes. Skipped unless
 * VIGENT_BINARY points at a built binary:
 *
 *   npm run build:binary
 *   VIGENT_BINARY=dist-bin/vigent-linux-x64/vigent node --test test/standalone.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { bundledBinary, selfCommand, standaloneDir } from "../dist/standalone.js";
import { Tty } from "./support/terminal.mjs";

const binary = process.env.VIGENT_BINARY ? path.resolve(process.env.VIGENT_BINARY) : undefined;
const windows = process.platform === "win32";
const hasPython = spawnSync("python3", ["-c", "import pty"]).status === 0;
const skip = !binary ? "set VIGENT_BINARY to a built standalone binary" : false;
const skipTty = skip || (windows || !hasPython ? "needs python3 and a Unix pty" : false);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-standalone-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));

test("beside the binary: its real folder through a symlink, and the programs shipped there", () => {
	const real = path.join(tmp, "opt");
	fs.mkdirSync(real);
	fs.writeFileSync(path.join(real, "vigent"), "");
	fs.writeFileSync(path.join(real, "riftri"), "");
	fs.mkdirSync(path.join(real, "folder"));
	assert.equal(standaloneDir(path.join(real, "vigent")), real);
	if (!windows) {
		fs.mkdirSync(path.join(tmp, "links"));
		fs.symlinkSync(path.join(real, "vigent"), path.join(tmp, "links", "vigent"));
		assert.equal(standaloneDir(path.join(tmp, "links", "vigent")), real, "a symlink on PATH leads to the folder with riftri in it");
	}
	assert.equal(standaloneDir(path.join(tmp, "gone", "vigent")), path.join(tmp, "gone"), "a path that doesn't resolve is used as it is");
	assert.equal(bundledBinary("riftri", real, "linux"), path.join(real, "riftri"));
	assert.equal(bundledBinary("riftri", real, "win32"), undefined, "riftri.exe on Windows");
	assert.equal(bundledBinary("folder", real, "linux"), undefined, "a folder isn't a program");
	assert.equal(bundledBinary("nope", real, "linux"), undefined);
});

test("running vigent again: the binary alone, or node with its script", () => {
	assert.deepEqual(selfCommand(["theme", "import"], true, "/opt/vigent/vigent", "/$bunfs/root/vigent"), { command: "/opt/vigent/vigent", args: ["theme", "import"] });
	assert.deepEqual(selfCommand(["theme", "import"], false, "/usr/bin/node", "/lib/vigent/dist/main.js"), { command: "/usr/bin/node", args: ["/lib/vigent/dist/main.js", "theme", "import"] });
});

// a fresh machine: git and a shell, no node, no agent CLIs but the stand-in, no riftri on PATH
const which = (name) => execFileSync(windows ? "where" : "which", [name], { encoding: "utf8" }).split("\n")[0].trim();
const bin = path.join(tmp, "bin");
const home = path.join(tmp, "home");
const repo = path.join(tmp, "shop");
const env = {
	PATH: bin,
	HOME: home,
	XDG_CONFIG_HOME: path.join(home, ".config"),
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
	GIT_AUTHOR_NAME: "T",
	GIT_AUTHOR_EMAIL: "t@e.com",
	GIT_COMMITTER_NAME: "T",
	GIT_COMMITTER_EMAIL: "t@e.com",
};
if (!skipTty) {
	fs.mkdirSync(bin);
	fs.mkdirSync(home);
	fs.mkdirSync(repo);
	const gitDir = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
	fs.symlinkSync(path.join(gitDir, "git"), path.join(bin, "git"));
	for (const tool of ["sh", "cat"]) fs.symlinkSync(fs.realpathSync(which(tool)), path.join(bin, tool));
	fs.symlinkSync(binary, path.join(bin, "vigent"));
	// a stand-in `claude` in shell (there's no node to run one): version, sign-in status, and a run that edits a file and streams Claude Code's JSON
	const fixture = path.join(import.meta.dirname, "fixtures", "claude-tool.jsonl");
	fs.writeFileSync(
		path.join(bin, "claude"),
		`#!${fs.realpathSync(which("sh"))}
if [ "$1" = "--version" ]; then echo "2.1.319 (Claude Code)"; exit 0; fi
if [ "$*" = "auth status --json" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi
echo hi > hello.txt
cat '${fixture}'
`,
	);
	fs.chmodSync(path.join(bin, "claude"), 0o755);
	const git = (args) => execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env, PATH: process.env.PATH } });
	git(["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(repo, "README.md"), "# shop\n");
	git(["add", "-A"]);
	git(["commit", "-qm", "init"]);
}

test("the binary knows its version and runs its commands", { skip }, () => {
	const run = (...args) => execFileSync(binary, args, { encoding: "utf8", env: { ...process.env, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, ".config") } });
	assert.equal(run("--version").trim(), `vigent ${pkg.version}`, "the package's version, and no commit: it isn't a clone");
	assert.match(run("--help"), /vim-native orchestrator/);
	const themes = run("theme", "list");
	for (const t of ["lazyvim", "tokyonight-moon", "default"]) assert.match(themes, new RegExp(`^${t}\\b`, "m"));
});

test("riftri ships beside the binary", { skip }, () => {
	const riftri = path.join(path.dirname(binary), windows ? "riftri.exe" : "riftri");
	assert.ok(fs.existsSync(riftri), `${riftri} is in the archive`);
	assert.match(execFileSync(riftri, ["--version"], { encoding: "utf8" }), /\d+\.\d+\.\d+/);
});

test("with no node on PATH: an agent works in its own worktree, and :checkhealth finds the riftri beside the binary", { skip: skipTty, timeout: 120000 }, async () => {
	assert.equal(spawnSync("node", ["--version"], { env }).error?.code, "ENOENT", "there's no node on this PATH");
	const t = new Tty([], { cwd: repo, env, command: [path.join(bin, "vigent")] });
	try {
		await t.waitFor(new RegExp(`vigent ${pkg.version.replace(/\./g, "\\.")}.* themes`));
		await t.waitFor(/● Claude Code +default/);
		await t.type("i");
		await t.waitFor("Enter starts an agent on Claude Code");
		await t.type("write a hello file\r");
		await t.waitFor(/▸ Write/);
		await t.waitFor(/│ done\s*$/m);

		const worktree = path.join(tmp, "shop-worktrees", "feat-write-hello-file");
		assert.ok(fs.existsSync(path.join(worktree, "hello.txt")), "the agent's edit is in its worktree");
		assert.ok(!fs.existsSync(path.join(repo, "hello.txt")), "your checkout is untouched");

		await t.ex("checkhealth");
		await t.waitFor(/vigent: agent engines/);
		await t.type("G"); // the worktrees part is under the engines
		const health = await t.waitFor(/lightweight worktrees/);
		assert.doesNotMatch(health, /riftri isn't installed|install: npm install -g riftri/, "riftri is found beside the binary, not on PATH");
		await t.type("q");
		await t.ex("qa!");
		assert.equal(await t.exited, 0);
	} finally {
		t.kill();
		// riftri may have mounted the worktree (OverlayFS): remove it its own way before the folder is deleted
		spawnSync(binary, ["worktree", "remove", "feat/write-hello-file", "--force"], { cwd: repo, env });
	}
});

test("install.sh: checks the download, installs vigent and riftri, and links vigent where PATH finds it", { skip: skip || (windows ? "the installer is for macOS and Linux" : false), timeout: 120000 }, () => {
	// the archive and SHA256SUMS the build wrote, served from disk in place of the GitHub release
	const built = path.dirname(path.dirname(binary));
	const target = path.basename(path.dirname(binary)).replace(/^vigent-/, "");
	const installer = path.join(import.meta.dirname, "..", "install.sh");
	const to = path.join(tmp, "installed");
	const links = path.join(tmp, "local-bin");
	const install = (base, extra = {}) =>
		spawnSync("sh", [installer], { encoding: "utf8", env: { ...process.env, HOME: tmp, VIGENT_INSTALL: to, VIGENT_BIN_DIR: links, VIGENT_TARGET: target, VIGENT_DOWNLOAD_BASE: base, ...extra } });

	// a download that isn't what the release listed is refused, and nothing is installed
	const bad = path.join(tmp, "tampered");
	fs.mkdirSync(bad);
	fs.copyFileSync(path.join(built, "SHA256SUMS"), path.join(bad, "SHA256SUMS"));
	fs.writeFileSync(path.join(bad, `vigent-${target}.tar.gz`), "not the archive");
	const refused = install(`file://${bad}`);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /checksum mismatch.*nothing was installed/);
	assert.ok(!fs.existsSync(to));

	const r = install(`file://${built}`);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, new RegExp(`installed vigent ${pkg.version.replace(/\./g, "\\.")} in `));
	assert.match(r.stdout, /add .*local-bin to your PATH/);
	assert.ok(fs.existsSync(path.join(to, "riftri")), "riftri is beside vigent");
	assert.equal(fs.realpathSync(path.join(links, "vigent")), path.join(to, "vigent"));
	assert.equal(execFileSync(path.join(links, "vigent"), ["--version"], { encoding: "utf8" }).trim(), `vigent ${pkg.version}`);

	// again over itself (an update), and a target with no archive
	assert.equal(install(`file://${built}`).status, 0);
	const none = install(`file://${built}`, { VIGENT_TARGET: "plan9-mips" });
	assert.notEqual(none.status, 0);
	assert.match(none.stderr, /couldn't download .*vigent-plan9-mips\.tar\.gz/);
});
