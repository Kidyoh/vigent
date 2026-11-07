import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { agentStateDir, loadAgentMeta, restorableAgents, saveAgentMeta, sessionDir, setDetached } from "../dist/agents.js";
import { itemsFromMessages } from "../dist/session.js";
import { createWorktree, DEFAULT_WORKTREE, removeWorktree } from "../dist/worktree.js";

// these tests cover plain git worktrees; riftri has its own (riftri.test.mjs)
process.env.RIFTRI_BINARY = path.join(os.tmpdir(), "vigent-no-riftri");

const GIT_ENV = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com" };
let tmp;
let repo;
const saved = {};
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

before(() => {
	for (const k of Object.keys(GIT_ENV)) {
		saved[k] = process.env[k];
		process.env[k] = GIT_ENV[k];
	}
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-restore-")));
	repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	sh(repo, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.js"), "1\n");
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

test("agent records live in git's worktree admin dir, not in your files", () => {
	const wt = createWorktree(repo, "fix flaky test");
	const dir = agentStateDir(wt.path);
	assert.match(dir, /\.git\/worktrees\/fix-flaky-test\/vigent$/);
	saveAgentMeta(wt.path, { name: "fix flaky test", model: "m1", base: "main", createdAt: "2026-01-01T00:00:00Z" });
	assert.equal(loadAgentMeta(wt.path).model, "m1");
	assert.equal(sh(wt.path, "status", "--porcelain"), "", "nothing shows up in the worktree");
	assert.equal(sh(repo, "status", "--porcelain"), "", "or in your checkout");
	assert.ok(sessionDir(wt.path).startsWith(dir));

	const removed = removeWorktree(repo, wt);
	assert.equal(removed.removed, true);
	assert.ok(!fs.existsSync(dir), "removing the worktree removes the record with it");
});

test("restorableAgents: saved agents in order; :kill'd ones are skipped until :attach", () => {
	const a = createWorktree(repo, "docs readme");
	const b = createWorktree(repo, "feat search");
	const c = createWorktree(repo, "chore no record");
	saveAgentMeta(b.path, { name: "feat search", model: "m", base: "main", createdAt: "2026-01-02T00:00:00Z" });
	saveAgentMeta(a.path, { name: "docs readme", model: "m", base: "main", createdAt: "2026-01-01T00:00:00Z" });
	let found = restorableAgents(repo, DEFAULT_WORKTREE);
	assert.deepEqual(found.map((r) => r.meta.name), ["docs readme", "feat search"]);
	assert.deepEqual(found[0].worktree, { branch: "docs/readme", path: a.path, base: "main" });
	assert.ok(!found.some((r) => r.worktree.path === c.path), "worktrees without a record aren't reopened");

	setDetached(a.path, true);
	found = restorableAgents(repo, DEFAULT_WORKTREE);
	assert.deepEqual(found.map((r) => r.meta.name), ["feat search"]);
	setDetached(a.path, false);
	assert.equal(restorableAgents(repo, DEFAULT_WORKTREE).length, 2);
	assert.equal(loadAgentMeta(c.path), undefined);
});

test("transcripts are rebuilt from pi's saved messages", () => {
	const { items, tokens } = itemsFromMessages([
		{ role: "user", content: "find the race" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
			],
			usage: { input: 10, output: 5 },
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "1 failing" }] },
		{ role: "assistant", content: [{ type: "text", text: "Fixed." }], usage: { input: 20, output: 3 } },
	]);
	assert.deepEqual(
		items.map((i) => [i.kind, i.text || i.tool?.name, i.tool?.output]),
		[
			["user", "find the race", undefined],
			["agent", "Looking.", undefined],
			["tool", "bash", "1 failing"],
			["agent", "Fixed.", undefined],
		],
	);
	assert.equal(items[2].tool.summary, "npm test");
	assert.equal(tokens, 38);
});

test("a pi agent's conversation survives a restart", async () => {
	const { PiSession } = await import("../dist/session.js");
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@mariozechner/pi-ai");
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "test");
	const agentDir = path.join(tmp, "pi");
	const wt = createWorktree(repo, "fix totals");
	const opts = { cwd: wt.path, worktree: wt, modelObject: faux.getModel(), authStorage, agentDir, sessionDir: sessionDir(wt.path) };
	const runOnce = (s, prompt) =>
		new Promise((resolve) => {
			const off = s.onChange(() => {
				if (s.state === "idle" && s.items.at(-1)?.kind === "agent" && !s.items.at(-1).streaming) {
					off();
					resolve();
				}
			});
			s.send(prompt);
		});

	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo 41 > total.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Wrote the total."),
	]);
	const first = new PiSession("fix totals", "faux", opts);
	await first.ready;
	await runOnce(first, "compute the total");
	first.dispose();

	// vigent restarts: a new session object over the same saved conversation
	let seenByModel;
	faux.setResponses([
		(context) => {
			seenByModel = context.messages.map((m) => m.role);
			return fauxAssistantMessage("It was 41.");
		},
	]);
	const second = new PiSession("fix totals", "faux", opts);
	try {
		await second.ready;
		assert.deepEqual(
			second.items.map((i) => i.kind),
			["user", "tool", "agent", "info"],
			"the earlier prompt, tool call and reply are back",
		);
		assert.equal(second.items[0].text, "compute the total");
		assert.equal(second.items[1].tool.summary, "echo 41 > total.txt");
		assert.match(second.items[3].text, /resumed: 1 earlier prompt/);

		await runOnce(second, "what was the total?");
		assert.deepEqual(seenByModel, ["user", "assistant", "toolResult", "assistant", "user"], "the model sees the earlier conversation");
		assert.equal(second.items.at(-1).text, "It was 41.");
	} finally {
		second.dispose();
		faux.unregister();
	}
});

test("the app: :kill keeps the agent for :attach; :attach focuses one already open", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	class S extends Session {
		send() {}
		abort() {}
	}
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 110, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), {
		root: repo,
		config: DEFAULT_WORKTREE,
	});
	app.newSession = (name) => {
		const wt = createWorktree(repo, name);
		saveAgentMeta(wt.path, { name, model: "m", base: wt.base, createdAt: new Date().toISOString() });
		return new S(name, "m", wt);
	};
	const attached = [];
	app.attachSession = (wt) => (attached.push(wt.branch), new S(loadAgentMeta(wt.path).name, "m", wt));
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("new perf cache warmup");
	const wt = app.focusedSession.worktree;
	ex("kill");
	assert.match(app.message, /:attach perf\/cache-warmup reopens it/);
	assert.equal(loadAgentMeta(wt.path).detached, true);
	assert.ok(!restorableAgents(repo, DEFAULT_WORKTREE).some((r) => r.worktree.path === wt.path));

	ex("attach perf/cache-warmup");
	assert.deepEqual(attached, ["perf/cache-warmup"]);
	assert.match(app.message, /attached 'perf cache warmup' to perf\/cache-warmup/);
	ex("attach perf/cache-warmup");
	assert.equal(attached.length, 1, "already open: just focus it");
	ex("attach nope");
	assert.match(app.message, /no worktree 'nope'/);
});
