import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap, KeySequencer } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { staleBuild } from "../dist/version.js";

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApp(opts = {}) {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 34, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.lazyvim), { ...DEFAULT_UI, ...opts }, new Keymap());
	app.defaultEngine = () => "claude";
	return { app, overlays };
}

test("which-key: a pause after <leader> keeps waiting instead of timing out; the next key runs; Esc drops it", async () => {
	const ran = [];
	const seq = new KeySequencer(new Keymap(), {
		mode: () => "normal",
		run: (b, keys) => ran.push(b ? b.rhsText : `unmapped ${keys.join("")}`),
		timeoutlen: () => 200,
		changed() {},
		hint: () => true,
		hintDelay: () => 50,
	});
	seq.feed("<Space>");
	await wait(400); // past timeoutlen: still waiting, because the hint is up
	assert.equal(seq.waiting, true);
	assert.deepEqual(ran, []);
	seq.feed("t");
	assert.deepEqual(ran, ["theme.picker"]);
	assert.equal(seq.waiting, false);

	seq.feed("<Space>");
	await wait(100);
	seq.feed("<Esc>");
	assert.deepEqual(seq.pendingKeys, []);
	assert.equal(ran.length, 1, "Esc runs nothing");
});

test("which-key: the panel lists what follows <Space>, in the app", async () => {
	const { app, overlays } = makeApp();
	app.addSession(new (class extends Session {
		send() {}
		abort() {}
	})("fix it", "m"), true);
	app.handleInput(" ");
	await wait(400);
	const screen = plain(app.render(120));
	assert.match(screen, /╭─ <Space> ─/);
	assert.match(screen, /n → Start an agent in its own worktree/);
	assert.match(screen, /t → Pick a colorscheme/);
	assert.match(screen, /M → Pick the agent's model/);
	assert.match(screen, /R → Pick its reasoning effort/);
	assert.match(screen, /e → Sessions sidebar: j\/k pick an agent/);
	assert.match(screen, /s → Theme, look, engine/);
	assert.match(screen, /Esc cancels/);
	app.handleInput("t");
	assert.equal(overlays.length, 1, "the next key runs its mapping");
	assert.doesNotMatch(plain(app.render(120)), /Esc cancels/, "and the panel goes away");

	const off = makeApp({ whichkey: false }).app;
	off.handleInput(" ");
	await wait(400);
	assert.doesNotMatch(plain(off.render(120)), /Esc cancels/, ":set nowhichkey");
});

test("the dashboard: LazyVim-style logo and one-key actions while no agent is open", () => {
	const { app, overlays } = makeApp();
	const screen = plain(app.render(120));
	assert.match(screen, /██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗/);
	for (const [label, key] of [["New agent: type a task, Enter", "i"], ["New agent by name", "n"], ["Theme", "t"], ["Settings", "s"], ["Model", "m"], ["Effort", "e"], ["Check engines", "c"], ["Keys", "\\?"], ["Quit", "q"]]) {
		assert.match(screen, new RegExp(`${label} +${key}(\\s|$)`, "m"), label);
	}

	app.handleInput("s");
	assert.match(plain(overlays.at(-1).render(90)), /Settings/);
	app.handleInput("t");
	assert.equal(overlays.length, 2);
	app.handleInput("?");
	assert.equal(overlays.length, 3);
	app.handleInput("n");
	assert.equal(app.mode, "COMMAND");
	assert.equal(app.cmdBuf, "new ");

	// with an agent open, those keys are the usual ones again
	const { app: busy, overlays: none } = makeApp();
	busy.addSession(new (class extends Session {
		send() {}
		abort() {}
	})("x", "m"), true);
	busy.handleInput("s");
	assert.equal(none.length, 0);
});

test("a clone whose build is older than its source says so", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-stale-"));
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		fs.mkdirSync(path.join(dir, "src"));
		fs.mkdirSync(path.join(dir, "dist"));
		fs.writeFileSync(path.join(dir, "src", "app.ts"), "");
		fs.writeFileSync(path.join(dir, "dist", "cli.js"), "");
		const hourAgo = new Date(Date.now() - 3600_000);
		fs.utimesSync(path.join(dir, "dist", "cli.js"), hourAgo, hourAgo);
		assert.match(staleBuild(dir), /built before its source last changed: run {2}npm install/);
		fs.utimesSync(path.join(dir, "src", "app.ts"), new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
		assert.equal(staleBuild(dir), undefined);
		fs.rmSync(path.join(dir, ".git"), { recursive: true });
		assert.equal(staleBuild(dir), undefined, "an npm install has no source to compare");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
