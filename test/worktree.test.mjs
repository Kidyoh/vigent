import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import {
	branchName,
	createWorktree,
	DEFAULT_WORKTREE,
	diffStat,
	diffText,
	findWorktree,
	listWorktrees,
	removeWorktree,
	repoRoot,
	slugify,
} from "../dist/worktree.js";

const GIT_ENV = {
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};
let tmp;
let repo;
const savedEnv = {};

function sh(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
	for (const k of Object.keys(GIT_ENV)) {
		savedEnv[k] = process.env[k];
		process.env[k] = GIT_ENV[k];
	}
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-wt-")));
	repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	sh(repo, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "app.js"), "one\ntwo\nthree\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-q", "-m", "init");
});

after(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("branch names follow conventional prefixes", () => {
	assert.equal(branchName("fix flaky checkout test"), "fix/flaky-checkout-test");
	assert.equal(branchName("Fix: the flaky Checkout test!"), "fix/the-flaky-checkout-test");
	assert.equal(branchName("auth-refactor"), "refactor/auth");
	assert.equal(branchName("docs: refresh README flags"), "docs/refresh-readme-flags");
	assert.equal(branchName("add dark mode"), "feat/add-dark-mode");
	assert.equal(branchName("bugfix cart badge"), "fix/cart-badge");
	assert.equal(branchName("test parser edge cases"), "test/parser-edge-cases");
	assert.equal(branchName("checkout fix"), "fix/checkout");
	assert.equal(branchName("fix"), "feat/fix", "a single word is the name, not the type");
	assert.equal(branchName("release/v2 notes"), "release/v2-notes", "a name with / is used as written");
	assert.equal(branchName("café menu"), "feat/cafe-menu");
	assert.equal(branchName("!!!"), "feat/agent");
	assert.equal(branchName("fix flaky test", "agent/{name}"), "agent/flaky-test");
	assert.equal(branchName("fix flaky test", "kinfe/{type}/{name}"), "kinfe/fix/flaky-test");
	const long = branchName("refactor the session middleware so it reads tokens from the new token store instead");
	assert.ok(long.length <= "refactor/".length + 48, long);
	assert.ok(!long.endsWith("-"));
	assert.equal(slugify("  Hello,   World  "), "hello-world");
});

test("creates a worktree on a new branch next to the repo", () => {
	assert.equal(repoRoot(repo), repo);
	assert.equal(repoRoot(tmp), undefined);
	const wt = createWorktree(repo, "fix flaky checkout test");
	assert.equal(wt.branch, "fix/flaky-checkout-test");
	assert.equal(wt.base, "main");
	assert.equal(wt.path, path.join(tmp, "shop-worktrees", "fix-flaky-checkout-test"));
	assert.ok(fs.existsSync(path.join(wt.path, "app.js")));
	assert.equal(sh(wt.path, "branch", "--show-current"), "fix/flaky-checkout-test");
	assert.equal(sh(repo, "branch", "--show-current"), "main", "your checkout is untouched");
	assert.equal(sh(repo, "status", "--porcelain"), "", "nothing appears in your checkout");
});

test("the same task twice gets a numbered branch instead of failing", () => {
	const a = createWorktree(repo, "docs pass");
	const b = createWorktree(repo, "docs pass");
	assert.equal(a.branch, "docs/pass");
	assert.equal(b.branch, "docs/pass-2");
	assert.notEqual(a.path, b.path);
});

test("custom pattern, folder and base", () => {
	sh(repo, "branch", "develop");
	const wt = createWorktree(repo, "add search", { ...DEFAULT_WORKTREE, dir: ".agents", branch: "agent/{name}", base: "develop" });
	assert.equal(wt.branch, "agent/add-search");
	assert.equal(wt.base, "develop");
	assert.equal(wt.path, path.join(repo, ".agents", "agent-add-search"));
	assert.equal(sh(repo, "status", "--porcelain"), "", "a worktrees folder inside the repo is excluded locally");
	createWorktree(repo, "add filters", { ...DEFAULT_WORKTREE, dir: ".agents", branch: "agent/{name}" });
	const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
	assert.equal(exclude.split("\n").filter((l) => l === "/.agents/").length, 1, "added once");
	assert.throws(() => createWorktree(repo, "x", { ...DEFAULT_WORKTREE, branch: "bad..{name}" }), /not a valid branch name/);
	assert.throws(() => createWorktree(repo, "y", { ...DEFAULT_WORKTREE, base: "no-such-branch" }), /git worktree add failed/);
});

test("diff stat and diff include commits, edits and new files", async () => {
	const wt = createWorktree(repo, "feat cart totals");
	assert.deepEqual(await diffStat(wt), { files: 0, added: 0, removed: 0 });

	fs.writeFileSync(path.join(wt.path, "app.js"), "one\nTWO\nthree\nfour\n");
	sh(wt.path, "commit", "-q", "-am", "edit");
	fs.writeFileSync(path.join(wt.path, "app.js"), "one\nTWO\nthree\nfour\nfive\n");
	fs.writeFileSync(path.join(wt.path, "cart.js"), "a\nb\n");
	fs.writeFileSync(path.join(wt.path, "logo.bin"), Buffer.from([0, 1, 2]));

	// a commit on main after the fork must not show up as a change
	fs.writeFileSync(path.join(repo, "later.js"), "x\n");
	sh(repo, "add", "later.js");
	sh(repo, "commit", "-q", "-m", "later on main");

	assert.deepEqual(await diffStat(wt), { files: 3, added: 5, removed: 1 });
	const text = await diffText(wt);
	assert.match(text, /^\+TWO$/m);
	assert.match(text, /^-two$/m);
	assert.match(text, /^\+five$/m);
	assert.match(text, /\+\+\+ b\/cart\.js/);
	assert.doesNotMatch(text, /later\.js/);
	assert.match(await diffText(wt, 3), /more lines$/);
});

test("removal is safe by default", () => {
	const wt = createWorktree(repo, "chore cleanup");
	fs.writeFileSync(path.join(wt.path, "wip.txt"), "unsaved\n");
	const refused = removeWorktree(repo, wt);
	assert.equal(refused.removed, false);
	assert.match(refused.message, /uncommitted changes/);
	assert.ok(fs.existsSync(wt.path));

	sh(wt.path, "add", ".");
	sh(wt.path, "commit", "-q", "-m", "wip");
	const kept = removeWorktree(repo, wt);
	assert.equal(kept.removed, true);
	assert.equal(kept.branchDeleted, false, "unmerged work keeps its branch");
	assert.match(sh(repo, "branch", "--list", "chore/cleanup"), /chore\/cleanup/);

	const clean = createWorktree(repo, "chore tidy");
	const gone = removeWorktree(repo, clean);
	assert.deepEqual([gone.removed, gone.branchDeleted], [true, true], "an untouched worktree and branch go away");

	const dirty = createWorktree(repo, "chore scratch");
	fs.writeFileSync(path.join(dirty.path, "x"), "x");
	assert.equal(removeWorktree(repo, dirty, true).removed, true, "force removes anyway");
});

test("lists and finds only vigent's worktrees", () => {
	sh(repo, "worktree", "add", "-q", path.join(tmp, "elsewhere"), "-b", "someone-else");
	const all = listWorktrees(repo);
	assert.ok(all.length >= 3);
	assert.ok(all.every((w) => w.path.startsWith(path.join(tmp, "shop-worktrees"))), "worktrees made outside vigent are ignored");
	assert.equal(findWorktree(repo, "fix/flaky-checkout-test")?.branch, "fix/flaky-checkout-test");
	assert.equal(findWorktree(repo, "fix-flaky-checkout-test")?.branch, "fix/flaky-checkout-test", "by folder name");
	assert.equal(findWorktree(repo, "fix flaky checkout test")?.branch, "fix/flaky-checkout-test", "by task name");
	assert.equal(findWorktree(repo, "nope"), undefined);
});

test("a pi agent's tools run inside its worktree", async () => {
	const { PiSession } = await import("../dist/session.js");
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@mariozechner/pi-ai");

	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "pwd > where.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("write", { path: "notes.md", content: "hello\nworld\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done: wrote notes.md."),
	]);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "test");
	const agentDir = path.join(tmp, "pi-agent");

	const wt = createWorktree(repo, "docs agent notes");
	const s = new PiSession("docs agent notes", "faux", {
		cwd: wt.path,
		worktree: wt,
		modelObject: faux.getModel(),
		authStorage,
		agentDir,
	});
	try {
		await s.ready;
		const idle = new Promise((resolve) => s.onChange(() => s.state === "idle" && s.items.some((i) => i.kind === "agent" && !i.streaming) && resolve()));
		s.send("leave some notes");
		await idle;

		assert.equal(fs.readFileSync(path.join(wt.path, "where.txt"), "utf8").trim(), wt.path);
		assert.equal(fs.readFileSync(path.join(wt.path, "notes.md"), "utf8"), "hello\nworld\n");
		assert.ok(!fs.existsSync(path.join(repo, "notes.md")), "your checkout is untouched");
		assert.deepEqual(
			s.items.filter((i) => i.kind === "tool").map((i) => i.tool.name),
			["bash", "write"],
		);
		assert.equal(s.items.at(-1).text, "Done: wrote notes.md.");

		await new Promise((r) => setTimeout(r, 400));
		assert.deepEqual(s.worktree.stat, { files: 2, added: 3, removed: 0 }, "live diff stat after the run");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test("the app: :new, :worktrees, :worktree remove, :kill, :kill!, :new!", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");

	class TestSession extends Session {
		send() {}
		abort() {}
	}
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 120 }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root: repo,
		config: DEFAULT_WORKTREE,
	});
	app.newSession = (name, { worktree }) => new TestSession(name, "m", worktree ? createWorktree(repo, name) : undefined);
	const ex = (cmd) => {
		for (const ch of [":", ...cmd, "\r"]) app.handleInput(ch);
	};
	const screen = () => app.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

	ex("new fix cart badge");
	const s = app.focusedSession;
	assert.equal(s.worktree.branch, "fix/cart-badge");
	assert.match(app.message, /on fix\/cart-badge in .*shop-worktrees.*fix-cart-badge \(from main\)/);
	assert.match(screen(), /fix\/cart-badge/, "sidebar shows the branch");

	fs.writeFileSync(path.join(s.worktree.path, "badge.js"), "1\n2\n");
	s.refreshStat(0);
	await new Promise((r) => setTimeout(r, 300));
	assert.match(screen(), /fix\/cart-badge \+2 −0/, "live +/- in the statusline");

	ex("worktrees");
	assert.equal(overlays.length, 1);
	const listing = overlays[0].render(96).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(listing, /● fix\/cart-badge\s+fix cart badge\s+\S*shop-worktrees/);

	ex("worktree remove fix/cart-badge");
	assert.match(app.message, /is working in fix\/cart-badge; stop it first/);

	ex("kill!");
	assert.match(app.message, /uncommitted changes/, "kill! still refuses to throw away work");
	assert.ok(fs.existsSync(s.worktree.path));
	ex("worktree remove! fix/cart-badge");
	assert.match(app.message, /removed .* and branch fix\/cart-badge/);
	assert.ok(!fs.existsSync(s.worktree.path));

	ex("new docs api notes");
	const keep = app.focusedSession.worktree;
	ex("kill");
	assert.match(app.message, /kept docs\/api-notes/);
	assert.ok(fs.existsSync(keep.path), ":kill keeps the worktree");

	ex("new! quick question");
	assert.equal(app.focusedSession.worktree, undefined);
	assert.match(app.message, /in this checkout/);
	ex("diff");
	assert.match(app.message, /has no worktree to diff/);
});
