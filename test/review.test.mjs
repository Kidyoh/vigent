import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { commitMessage, githubWebUrl, mergeWorktree, openPullRequest } from "../dist/review.js";
import { createWorktree, removeWorktree } from "../dist/worktree.js";

// these tests cover plain git worktrees; riftri has its own (riftri.test.mjs)
process.env.RIFTRI_BINARY = path.join(os.tmpdir(), "vigent-no-riftri");

const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
let tmp;
let repo;
const saved = {};
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);

before(() => {
	for (const k of Object.keys(GIT_ENV)) {
		saved[k] = process.env[k];
		process.env[k] = GIT_ENV[k];
	}
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-review-")));
	repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	sh(repo, "init", "-q", "-b", "main");
	write(repo, "cart.js", "one\ntwo\nthree\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-q", "-m", "init");
});

after(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("commit messages come from the branch name", () => {
	assert.equal(commitMessage("fix/flaky-checkout-test"), "fix: flaky checkout test");
	assert.equal(commitMessage("docs/refresh-readme-2"), "docs: refresh readme");
	assert.equal(commitMessage("agent/add-search"), "add search");
	assert.equal(commitMessage("kinfe/feat/dark-mode"), "feat: dark mode");
});

test(":merge squash-merges into the base, committing the agent's pending work first", () => {
	const wt = createWorktree(repo, "fix cart badge");
	write(wt.path, "cart.js", "one\nTWO\nthree\n");
	sh(wt.path, "commit", "-q", "-am", "uppercase two");
	write(wt.path, "badge.js", "export const badge = 1;\n"); // left uncommitted by the agent

	const before = sh(repo, "rev-parse", "HEAD");
	const r = mergeWorktree(repo, wt);
	assert.equal(r.ok, true, r.message);
	assert.match(r.message, /squash-merged fix\/cart-badge into main as \w+ \(committed the agent's pending changes first\)/);
	assert.equal(sh(repo, "rev-list", "--count", `${before}..HEAD`), "1", "one commit, like a squash merge");
	assert.equal(sh(repo, "log", "-1", "--format=%s"), "fix: cart badge");
	assert.match(sh(repo, "log", "-1", "--format=%b"), /- uppercase two\n- fix: cart badge/);
	assert.equal(fs.readFileSync(path.join(repo, "cart.js"), "utf8"), "one\nTWO\nthree\n");
	assert.ok(fs.existsSync(path.join(repo, "badge.js")));
	assert.equal(sh(repo, "status", "--porcelain"), "");

	assert.match(mergeWorktree(repo, wt).message, /nothing to merge/);
	const removed = removeWorktree(repo, wt);
	assert.deepEqual([removed.removed, removed.branchDeleted], [true, true], "a squash-merged branch counts as merged");
});

test(":merge refuses to touch a checkout that isn't ready", () => {
	const wt = createWorktree(repo, "feat totals");
	write(wt.path, "totals.js", "1\n");

	write(repo, "cart.js", "local edit\n");
	assert.match(mergeWorktree(repo, wt).message, /your checkout has uncommitted changes/);
	sh(repo, "checkout", "-q", "--", "cart.js");

	sh(repo, "checkout", "-q", "-b", "elsewhere");
	assert.match(mergeWorktree(repo, wt).message, /your checkout is on 'elsewhere'; switch it to 'main'/);
	sh(repo, "checkout", "-q", "main");

	assert.equal(mergeWorktree(repo, { branch: "x" }).ok, false);
});

test("a conflict is rolled back and leaves your checkout exactly as it was", () => {
	const wt = createWorktree(repo, "fix line three");
	write(wt.path, "cart.js", "one\nTWO\nagent three\n");
	write(repo, "cart.js", "one\nTWO\nyour three\n");
	sh(repo, "commit", "-q", "-am", "your change");

	const head = sh(repo, "rev-parse", "HEAD");
	const r = mergeWorktree(repo, wt);
	assert.equal(r.ok, false);
	assert.match(r.message, /merge conflict, nothing changed/);
	assert.equal(sh(repo, "rev-parse", "HEAD"), head);
	assert.equal(sh(repo, "status", "--porcelain"), "");
	assert.equal(fs.readFileSync(path.join(repo, "cart.js"), "utf8"), "one\nTWO\nyour three\n");
});

test(":merge --no-squash makes a merge commit", () => {
	const wt = createWorktree(repo, "docs readme");
	write(wt.path, "README.md", "# shop\n");
	const r = mergeWorktree(repo, wt, { squash: false });
	assert.equal(r.ok, true, r.message);
	assert.equal(sh(repo, "log", "-1", "--format=%s"), "Merge branch 'docs/readme'");
	assert.equal(sh(repo, "log", "-1", "--format=%p").split(" ").length, 2);
});

test(":pr pushes the branch and gives the compare URL without gh", () => {
	const bare = path.join(tmp, "origin.git");
	sh(tmp, "init", "-q", "--bare", bare);
	sh(repo, "remote", "add", "origin", bare);
	const wt = createWorktree(repo, "feat search box");
	write(wt.path, "search.js", "find()\n");

	const r = openPullRequest(repo, wt, { useGh: false });
	assert.equal(r.ok, true, r.message);
	assert.match(sh(repo, "ls-remote", "--heads", "origin"), /refs\/heads\/feat\/search-box/);
	assert.match(r.message, /pushed feat\/search-box/);

	assert.equal(githubWebUrl("git@github.com:farming-labs/vigent.git"), "https://github.com/farming-labs/vigent");
	assert.equal(githubWebUrl("https://github.com/farming-labs/vigent"), "https://github.com/farming-labs/vigent");
	assert.equal(githubWebUrl("https://gitlab.com/a/b.git"), undefined);

	assert.match(openPullRequest(repo, wt, { remote: "nope", useGh: false }).message, /no 'nope' remote/);
});

test("the app: :merge then :kill! leaves main with one commit and no leftovers", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	const { DEFAULT_WORKTREE } = await import("../dist/worktree.js");
	class S extends Session {
		send() {}
		abort() {}
	}
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 110, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root: repo,
		config: DEFAULT_WORKTREE,
	});
	app.newSession = (name) => new S(name, "m", createWorktree(repo, name));
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("new fix totals rounding");
	const wt = app.focusedSession.worktree;
	write(wt.path, "totals.js", "Math.round(x)\n");
	const before = sh(repo, "rev-parse", "HEAD");
	ex("merge");
	assert.match(app.message, /squash-merged fix\/totals-rounding into main .* :kill! cleans up the worktree/);
	assert.equal(sh(repo, "rev-list", "--count", `${before}..HEAD`), "1");
	ex("kill!");
	assert.match(app.message, /removed .* and branch fix\/totals-rounding/);
	assert.equal(sh(repo, "branch", "--list", "fix/totals-rounding"), "");
	assert.ok(!fs.existsSync(wt.path));
});
