import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App, formatCost, formatTokens, formatUsage, totalUsage } from "../dist/app.js";
import { CLI_ADAPTERS, CliSession } from "../dist/cli-engines.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { itemsFromMessages, Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-usage-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fixture = (name) => path.join(import.meta.dirname, "fixtures", name);
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** a stand-in CLI that prints a captured run */
function fakeCli(name, jsonl) {
	const bin = path.join(tmp, `${name}-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write(require("fs").readFileSync(${JSON.stringify(jsonl)}, "utf8"));\n`);
	fs.chmodSync(bin, 0o755);
	return bin;
}

async function run(s, prompt) {
	s.send(prompt);
	for (let i = 0; i < 200 && s.state === "running"; i++) await tick();
}

class S extends Session {
	send() {}
	abort() {}
}

test("formatting: tokens, money, both", () => {
	assert.equal(formatTokens(950), "950 tok");
	assert.equal(formatTokens(12_400), "12.4k tok");
	assert.equal(formatTokens(3_250_000), "3.3M tok");
	assert.equal(formatCost(0.251577), "$0.25");
	assert.equal(formatCost(0.0042), "$0.004", "under a cent: a tenth of a cent");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatUsage({ tokens: 12_400, cost: 0.31 }), "12.4k tok · $0.31");
	assert.equal(formatUsage({ tokens: 12_400 }), "12.4k tok", "no price reported: no price shown");
	assert.deepEqual(totalUsage([{ tokens: 10, cost: 0.5 }, { tokens: 5 }, { tokens: 0 }, { tokens: 1, cost: 0.25 }]), { tokens: 16, cost: 0.75, unpriced: 1 });
	assert.deepEqual(totalUsage([{ tokens: 5 }]), { tokens: 5, cost: undefined, unpriced: 1 });
});

test("each engine's reported cost: Claude Code's total_cost_usd, OpenCode's step cost, pi's usage; Codex reports none", async () => {
	const parse = (id, file) => fs.readFileSync(fixture(file), "utf8").trim().split("\n").flatMap((l) => CLI_ADAPTERS[id].parser()(JSON.parse(l)));
	assert.deepEqual(
		parse("claude", "claude-tool.jsonl").filter((e) => e.type === "usage").map((e) => e.cost),
		[0.251577],
	);
	assert.deepEqual(
		parse("opencode", "opencode-tool.jsonl").filter((e) => e.type === "usage").map((e) => e.cost),
		[0],
		"OpenCode prices each step (this model is free)",
	);
	assert.ok(parse("codex", "codex-tool.jsonl").filter((e) => e.type === "usage").every((e) => e.cost === undefined));

	// a Claude Code agent adds up across runs
	const claude = new CliSession("racer", "claude", undefined, { cwd: tmp, bin: fakeCli("claude", fixture("claude-tool.jsonl")) });
	assert.equal(claude.cost, undefined, "nothing spent yet");
	await run(claude, "one");
	await run(claude, "two");
	assert.equal(claude.cost.toFixed(6), (0.251577 * 2).toFixed(6));
	assert.ok(claude.tokens > 70_000, "cached tokens count: Claude Code read them");

	const codex = new CliSession("fixer", "codex", undefined, { cwd: tmp, bin: fakeCli("codex", fixture("codex-tool.jsonl")) });
	await run(codex, "go");
	assert.ok(codex.tokens > 0);
	assert.equal(codex.cost, undefined, "Codex prints tokens, not prices");

	// pi: usage.cost.total on each reply, summed again when a conversation is reopened
	const usage = (total, n) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: 2 * n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
	const restored = itemsFromMessages([
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "a" }], usage: usage(0.01, 100) },
		{ role: "user", content: "again" },
		{ role: "assistant", content: [{ type: "text", text: "b" }], usage: usage(0.02, 50) },
	]);
	assert.equal(restored.tokens, 300);
	assert.equal(restored.cost.toFixed(2), "0.03");
});

test("the statusline, :dash and :cost show what each agent used and the total", () => {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const a = new S("fix the race", "claude-fable-5");
	a.engine = "claude";
	a.tokens = 74_810;
	a.cost = 0.503154;
	const b = new S("add retries", "gpt-5.5");
	b.engine = "codex";
	b.tokens = 21_300;
	const c = new S("rename the flag", "gpt-5.5");
	c.engine = "opencode";
	c.tokens = 0;
	app.addSession(a, true);
	app.addSession(b, false);
	app.addSession(c, false);

	assert.match(plain(app.render(120)), /claude-fable-5 {2}74\.8k tok · \$0\.50 {2}0\/3/);

	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	ex("dash");
	let screen = plain(overlays.at(-1).render(110));
	assert.match(screen, /fix the race .*74\.8k tok · \$0\.50/);
	assert.match(screen, /add retries .*21\.3k tok(?! ·)/);
	assert.match(screen, /3 agents · 0 running · 96\.1k tok · \$0\.50 in all/);

	ex("cost");
	screen = plain(overlays.at(-1).render(72));
	assert.match(screen, /Usage/);
	assert.match(screen, /agent +engine +tokens +cost/);
	assert.match(screen, /fix the race +Claude Code +74\.8k +\$0\.50/);
	assert.match(screen, /add retries +Codex +21\.3k +—/);
	assert.match(screen, /rename the flag +OpenCode +0 +—/);
	assert.match(screen, /all agents +96\.1k +\$0\.50/);
	assert.match(screen, /Codex reports no price \(—\); its tokens are counted/);
	// Enter jumps to the agent, like :dash
	overlays.at(-1).handleInput("j");
	overlays.at(-1).handleInput("\r");
	assert.equal(app.focusedSession, b);
});

test("a finished run saves the agent's totals (so they survive a restart)", () => {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const saved = [];
	app.persist = (s) => saved.push({ tokens: s.tokens, cost: s.cost });
	const a = new S("fix the race", "m");
	app.addSession(a, true);
	a.setState("running");
	assert.deepEqual(saved, [], "starting saves nothing");
	a.tokens = 1200;
	a.cost = 0.04;
	a.setState("idle");
	assert.deepEqual(saved, [{ tokens: 1200, cost: 0.04 }]);
});
