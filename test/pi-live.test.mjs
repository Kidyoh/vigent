/**
 * The real vigent, in a real terminal, running a pi agent: your pi (here the
 * devDependency's) in RPC mode against a stand-in model server.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { realPi } from "./support/pi.mjs";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-pilive-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("vigent --engine pi: a prompt runs pi's whole loop in the agent's worktree, and the agent comes back after a restart", { timeout: 120000 }, async () => {
	const repo = path.join(tmp, "shop");
	fs.mkdirSync(repo);
	const git = (...a) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", ...a], { cwd: repo });
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "cart.js"), "export const total = (items) => items.length;\n");
	git("add", ".");
	git("commit", "-qm", "init");

	const pi = await realPi(tmp, [
		{ tool: "bash", args: { command: "cat cart.js" } },
		{ tool: "edit", args: { path: "cart.js", edits: [{ oldText: "items.length", newText: "items.reduce((n, i) => n + i.qty, 0)" }] } },
		{ text: "The badge counted lines; it now sums quantities." },
	]);
	const env = { ...pi.env, XDG_CONFIG_HOME: path.join(tmp, "xdg"), XDG_STATE_HOME: path.join(tmp, "state"), RIFTRI_BINARY: path.join(tmp, "none"), TERM: "xterm-256color" };
	const t = new Tty(["--engine", "pi"], { cwd: repo, env, cols: 140, rows: 32 });
	try {
		await t.waitFor(/SESSIONS/);
		await t.type("i");
		await t.type("fix the cart badge\r");
		await t.waitFor(/it now sums quantities\./, 30000);
		const screen = t.screen();
		assert.match(screen, /fake\/test/, "the winbar names pi's model");
		assert.match(screen, /bash/, "pi's tool calls show");
		await t.ex("q!");
	} finally {
		t.kill();
	}
	// the edit happened in the agent's worktree, not your checkout
	assert.equal(fs.readFileSync(path.join(repo, "cart.js"), "utf8"), "export const total = (items) => items.length;\n");
	const wt = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice(9))
		.find((p) => p !== repo);
	assert.ok(wt, "a worktree was made");
	assert.match(fs.readFileSync(path.join(wt, "cart.js"), "utf8"), /i\.qty/);

	// restart: the agent reopens with its conversation (pi's session file in the worktree)
	const again = new Tty([], { cwd: repo, env, cols: 140, rows: 32 });
	try {
		await again.waitFor(/it now sums quantities\./, 30000);
		await again.waitFor(/resumed: 1 earlier prompt/);
	} finally {
		again.kill();
		await pi.close();
	}
});
