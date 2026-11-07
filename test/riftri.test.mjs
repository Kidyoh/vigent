import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { prepareViews, riftriBackends, riftriHealth } from "../dist/riftri.js";
import { createWorktree, DEFAULT_WORKTREE, listWorktrees, removeWorktree } from "../dist/worktree.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-riftri-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" };
Object.assign(process.env, GIT_ENV);
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo(dir) {
	fs.mkdirSync(dir, { recursive: true });
	git(["init", "-q", "-b", "main"], dir);
	fs.writeFileSync(path.join(dir, "cart.js"), "export const total = (items) => items.length;\n");
	git(["add", "-A"], dir);
	git(["commit", "-qm", "init"], dir);
	return dir;
}

// A stand-in riftri that follows its JSON contract: reports on stdout, receipts on stderr.
const LOG = path.join(tmp, "riftri.log");
const FAKE = path.join(tmp, "fake-riftri");
fs.writeFileSync(
	FAKE,
	`#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
let args = process.argv.slice(2);
if (args[0] === "--json-errors") args = args.slice(1);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(args) + "\\n");
const mode = process.env.FAKE_RIFTRI_MODE || "ok";
const out = (o) => console.log(JSON.stringify({ schema_version: 1, ...o }));
const receipt = (o, code) => { process.stderr.write(JSON.stringify({ schemaVersion: 1, outcome: "failed", ...o }) + "\\n"); process.exit(code); };
const g = (a, cwd) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const stateDir = path.join(g(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "riftri");
const file = path.join(stateDir, "fake-views.json");
const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
const save = (m) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(m)); };
const positional = args.filter((a) => !a.startsWith("--"));
if (args[0] === "--version") { console.log("riftri 0.6.6"); process.exit(0); }
switch (args[0] + " " + (args[1] ?? "")) {
	case "worktree add": {
		if (mode === "decline") receipt({ category: "policy", cleanup: "not-needed", code: "unsupported-checkout", message: "unsupported optimized checkout: GIT_CONFIG_COUNT is set" }, 3);
		if (mode === "broken") receipt({ category: "operational", cleanup: "rolled-back", code: "storage", message: "clone failed: Input/output error", nextCommand: "riftri repair" }, 1);
		const dest = args[2], branch = args[args.indexOf("-b") + 1], base = args[args.indexOf("-b") + 2];
		g(["worktree", "add", "-q", "-b", branch, dest, base]);
		const m = load(); m[dest] = { backend: "reflink", mount: null }; save(m);
		out({ backend: "reflink", destination: dest, reused_base: false, base_path: "/b" });
		break;
	}
	case "worktree inspect": {
		const m = load();
		out({ worktrees: args.slice(args.indexOf("--") + 1).map((p) => ({ path: p, backend: m[p]?.backend ?? null, mount_status: m[p] ? m[p].mount : null, state_directory: m[p] ? stateDir : null })) });
		break;
	}
	case "worktree remove": {
		const p = positional[2], m = load();
		if (!args.includes("--force") && g(["status", "--porcelain"], p)) receipt({ category: "policy", cleanup: "not-needed", code: "invalid-request", message: "invalid worktree request: worktree " + p + " has changes; commit, stash, or remove them before retrying" }, 3);
		g(["worktree", "remove", "--force", p]);
		delete m[p]; save(m);
		out({ destination: p, forced: args.includes("--force") });
		break;
	}
	case "repair --state-dir": {
		const m = load();
		if (mode !== "stuck") for (const k of Object.keys(m)) if (m[k].mount === "recovery-required") m[k].mount = "active";
		save(m); out({ recovered_mounts: 1, errors: [] });
		break;
	}
	case "gc --apply": out({ applied: true, removed_allocated_bytes: 4096 }); break;
	case "doctor --destination":
		out({ destination_readiness: mode === "decline"
			? { status: "blocked", copy_on_write: true, backend: "reflink", next_command: null, blockers: [{ kind: "checkout-compatibility", explanation: "GIT_CONFIG_COUNT is set", remedy: "unset it" }] }
			: { status: "needs-activation", copy_on_write: true, backend: "reflink", next_command: "riftri enable '/x'", blockers: [{ kind: "repository-activation", explanation: "interception is off" }] } });
		break;
	case "status --json": out({ operations: { active_views: Object.keys(load()).length }, total_logical_bytes: 30 * 1024 * 1024, total_allocated_bytes: 10 * 1024 * 1024 }); break;
	default: receipt({ category: "usage", code: "usage", message: "unexpected: " + args.join(" ") }, 2);
}
`,
);
fs.chmodSync(FAKE, 0o755);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const useFake = (mode = "ok") => {
	process.env.RIFTRI_BINARY = FAKE;
	process.env.FAKE_RIFTRI_MODE = mode;
	fs.rmSync(LOG, { force: true });
};

test("auto: riftri makes the agent's worktree; removing goes through riftri, then frees unused storage", () => {
	const repo = makeRepo(path.join(tmp, "ok"));
	useFake("ok");
	const wt = createWorktree(repo, "fix flaky checkout test");
	assert.equal(wt.riftri, "reflink");
	assert.equal(wt.branch, "fix/flaky-checkout-test");
	assert.deepEqual(calls()[0], ["worktree", "add", wt.path, "-b", "fix/flaky-checkout-test", "main", "--json", "--no-progress"]);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt.path), "fix/flaky-checkout-test", "a real git worktree");
	assert.deepEqual(listWorktrees(repo).map((w) => w.branch), ["fix/flaky-checkout-test"]);
	assert.deepEqual([...riftriBackends(repo, [wt.path, repo])], [[wt.path, "reflink"]]);

	// dirty: refused, like git's own
	fs.appendFileSync(path.join(wt.path, "cart.js"), "// wip\n");
	const refused = removeWorktree(repo, wt);
	assert.equal(refused.removed, false);
	assert.match(refused.message, /has uncommitted changes; use force/);
	assert.ok(fs.existsSync(wt.path));

	fs.rmSync(LOG, { force: true });
	const removed = removeWorktree(repo, wt, true);
	assert.equal(removed.removed, true);
	assert.match(removed.message, /removed .* and branch fix\/flaky-checkout-test/);
	assert.deepEqual(
		calls().map((c) => c.slice(0, 2).join(" ")),
		["worktree inspect", "worktree remove", "gc --apply"],
	);
	assert.ok(calls()[1].includes("--force"));
	assert.ok(!fs.existsSync(wt.path));
});

test("auto: riftri declines (policy receipt, nothing changed) → a plain git worktree, and vigent says why", () => {
	const repo = makeRepo(path.join(tmp, "decline"));
	useFake("decline");
	const wt = createWorktree(repo, "docs readme");
	assert.equal(wt.riftri, undefined);
	assert.match(wt.riftriSkipped, /GIT_CONFIG_COUNT is set/);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], wt.path), "docs/readme");
	// no riftri state: removal is git's, without asking riftri
	fs.rmSync(LOG, { force: true });
	assert.equal(removeWorktree(repo, wt).removed, true);
	assert.deepEqual(calls(), []);
});

test("a riftri failure that isn't a clean refusal is reported, never retried with git", () => {
	const repo = makeRepo(path.join(tmp, "broken"));
	useFake("broken");
	assert.throws(() => createWorktree(repo, "feat search"), /riftri worktree add failed: clone failed: Input\/output error \(riftri suggests: riftri repair\)/);
	assert.deepEqual(listWorktrees(repo), [], "no git worktree behind riftri's back");

	useFake("decline");
	assert.throws(() => createWorktree(repo, "feat search", { ...DEFAULT_WORKTREE, backend: "riftri" }), /riftri worktree add failed: unsupported/);
	process.env.RIFTRI_BINARY = path.join(tmp, "missing-riftri");
	assert.throws(() => createWorktree(repo, "feat search", { ...DEFAULT_WORKTREE, backend: "riftri" }), /backend is "riftri", but riftri isn't installed: npm install -g riftri/);

	useFake("ok");
	const plain = createWorktree(repo, "chore tidy", { ...DEFAULT_WORKTREE, backend: "git" });
	assert.equal(plain.riftri, undefined);
	assert.deepEqual(calls(), [], "backend = git never runs riftri");
});

test("riftri worktrees but no riftri: vigent won't remove them with plain git", () => {
	const repo = makeRepo(path.join(tmp, "uninstalled"));
	useFake("ok");
	const wt = createWorktree(repo, "fix totals");
	process.env.RIFTRI_BINARY = path.join(tmp, "missing-riftri");
	const r = removeWorktree(repo, wt);
	assert.equal(r.removed, false);
	assert.match(r.message, /riftri isn't installed/);
	assert.ok(fs.existsSync(wt.path));
	useFake("ok");
	assert.equal(removeWorktree(repo, wt).removed, true);
});

test("before reopening agents: views whose mount went away are repaired, then inspected again", () => {
	const repo = makeRepo(path.join(tmp, "restore"));
	useFake("ok");
	const a = createWorktree(repo, "feat a");
	const b = createWorktree(repo, "feat b");
	const views = path.join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo), "riftri", "fake-views.json");
	const setMount = (p, mount) => {
		const m = JSON.parse(fs.readFileSync(views, "utf8"));
		m[p] = { backend: "overlay-fs", mount };
		fs.writeFileSync(views, JSON.stringify(m));
	};
	setMount(a.path, "recovery-required");
	setMount(b.path, "active");
	fs.rmSync(LOG, { force: true });
	let ready = prepareViews(repo, [a.path, b.path]);
	assert.deepEqual([...ready.values()].map((v) => [v.ready, v.backend]), [[true, "overlay-fs"], [true, "overlay-fs"]]);
	assert.deepEqual(calls().map((c) => c.slice(0, 2).join(" ")), ["worktree inspect", "repair --state-dir", "worktree inspect"]);

	setMount(a.path, "recovery-required");
	process.env.FAKE_RIFTRI_MODE = "stuck";
	ready = prepareViews(repo, [a.path, b.path]);
	assert.equal(ready.get(a.path).ready, false);
	assert.match(ready.get(a.path).reason, /recovery-required; run: riftri repair --state-dir/);
	assert.equal(ready.get(b.path).ready, true);

	process.env.RIFTRI_BINARY = path.join(tmp, "missing-riftri");
	assert.equal(prepareViews(repo, [a.path]).get(a.path).ready, true, "no riftri: nothing to check");
});

test(":checkhealth and :worktrees show riftri and what the worktrees cost", async () => {
	const repo = makeRepo(path.join(tmp, "health"));
	useFake("ok");
	const wt = createWorktree(repo, "feat cart");
	let h = await riftriHealth(repo, path.join(tmp, "health-worktrees"), "auto");
	assert.deepEqual(
		[h.installed, h.version, h.ready, h.backend, h.detail, h.blockers, h.views, h.logicalBytes, h.allocatedBytes],
		[true, "0.6.6", true, "reflink", "copy-on-write worktrees (Btrfs/XFS reflinks)", [], 1, 30 * 1024 * 1024, 10 * 1024 * 1024],
		"needs-activation is only about riftri's git shim; vigent calls riftri directly",
	);
	process.env.FAKE_RIFTRI_MODE = "decline";
	const blocked = await riftriHealth(repo, path.join(tmp, "health-worktrees"), "auto");
	assert.deepEqual([blocked.ready, blocked.blockers], [false, ["GIT_CONFIG_COUNT is set · unset it"]]);
	assert.equal((await riftriHealth(repo, tmp, "git")).detail, 'off ([worktree] backend = "git")');
	process.env.RIFTRI_BINARY = path.join(tmp, "missing-riftri");
	assert.match((await riftriHealth(repo, tmp, "auto")).detail, /not installed: agent worktrees are full copies/);
	useFake("ok");

	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 130, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root: repo,
		config: DEFAULT_WORKTREE,
	});
	app.storage = h;
	app.engines = [];
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	const plain = (c) => c.render(126).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	ex("checkhealth");
	const health = plain(overlays.at(-1));
	assert.match(health, /● riftri {2}0\.6\.6 {2}lightweight git worktrees · riftri\.dev/);
	assert.match(health, /OK copy-on-write worktrees \(Btrfs\/XFS reflinks\)/);
	assert.match(health, /1 worktree: 30\.0 MB of files in 10\.0 MB on disk \(saves 20\.0 MB\)/);

	ex("worktrees");
	const list = plain(overlays.at(-1));
	assert.match(list, /feat\/cart .*riftri reflink/);
	assert.match(list, /riftri: 30\.0 MB of files in 10\.0 MB on disk \(Btrfs\/XFS reflinks\)/);
	removeWorktree(repo, wt, true);
});

// The real thing, on a copy-on-write volume: VIGENT_COW_DIR=/mnt/btrfs npm test
const cow = process.env.VIGENT_COW_DIR;
test("real riftri on a copy-on-write volume: agents share storage", { skip: !cow && "set VIGENT_COW_DIR to a Btrfs/XFS/APFS folder" }, async () => {
	delete process.env.RIFTRI_BINARY; // the riftri package installed with vigent
	// cloud sandboxes inject network-only git config (GIT_CONFIG_COUNT); riftri 0.6.7 accepts it
	const repo = makeRepo(fs.mkdtempSync(path.join(cow, "vigent-cow-")));
	try {
		for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(repo, `f${i}.txt`), "x".repeat(64 * 1024));
		git(["add", "-A"], repo);
		git(["commit", "-qm", "files"], repo);
		const a = createWorktree(repo, "feat a");
		const b = createWorktree(repo, "feat b");
		assert.ok(a.riftri && b.riftri, `riftri made both (${a.riftriSkipped ?? b.riftriSkipped ?? ""})`);
		const h = await riftriHealth(repo, path.dirname(a.path), "auto");
		assert.equal(h.ready, true, h.detail);
		assert.equal(h.views, 2);
		assert.ok(h.allocatedBytes < h.logicalBytes / 2, `${h.allocatedBytes} on disk for ${h.logicalBytes} of files`);
		assert.equal(removeWorktree(repo, a, true).removed, true);
		assert.equal(removeWorktree(repo, b, true).removed, true);
		assert.deepEqual(listWorktrees(repo), []);
	} finally {
		fs.rmSync(path.dirname(path.join(repo, "x")), { recursive: true, force: true });
		fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
	}
});
