import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { newAccessCode, startServer } from "../dist/serve.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, extractPalette, Painter } from "../dist/theme.js";

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const until = async (fn, ms = 5000) => {
	const end = Date.now() + ms;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};

class S extends Session {
	sent = [];
	aborted = 0;
	send(t) {
		this.sent.push(t);
		this.pushUser(t);
		this.setState("running");
	}
	abort() {
		this.aborted++;
		this.setState("idle");
	}
}

function fakeHost() {
	const a = new S("fix the race", "claude-fable-5");
	a.engine = "claude";
	a.worktree = { branch: "fix/the-race", stat: { added: 12, removed: 3, files: 2 } };
	a.tokens = 74_810;
	a.cost = 0.5;
	a.pushUser("the checkout test is flaky");
	a.items.push({ kind: "agent", text: "Found it: two writers race on `cart.total`.\n\n```js\nawait lock(cart);\n```" });
	a.items.push({ kind: "tool", text: "", tool: { name: "bash", summary: "npm test", output: "ok 12 tests", folded: true } });
	const sessions = [a];
	const notes = [];
	const host = {
		sessions: () => sessions,
		project: () => "shop",
		palette: () => extractPalette(BUILTIN_THEMES.lazyvim ?? BUILTIN_THEMES.default),
		isUnread: () => false,
		startAgent: (task) => {
			const s = new S(task.split(" ").slice(0, 3).join(" "), "default");
			sessions.push(s);
			return s;
		},
		notify: (t) => notes.push(t),
	};
	return { a, sessions, notes, host };
}

const CODE = "abcd-2345";

test("access codes are short, easy to type, and new each time", () => {
	const codes = new Set(Array.from({ length: 50 }, newAccessCode));
	assert.equal(codes.size, 50);
	for (const c of codes) assert.match(c, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/, "no 0/o/1/l/i");
});

test("the API: the access code guards everything, changes need it in a header, and 10 wrong codes lock it", async () => {
	const { a, sessions, notes, host } = fakeHost();
	const sv = await startServer(host, { port: 0, host: "127.0.0.1", code: CODE });
	const base = `http://127.0.0.1:${sv.port}`;
	const auth = { authorization: `Bearer ${CODE}` };
	const post = (p, body, headers = auth) => fetch(base + p, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		assert.deepEqual(sv.urls, [`http://127.0.0.1:${sv.port}/`], "local: this machine only");

		// the page itself is public, and locked down
		const page = await fetch(base + "/");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy"), /default-src 'none'.*connect-src 'self'/);
		const html = await page.text();
		assert.match(html, /<title>vigent · shop<\/title>/);
		assert.ok(html.includes(extractPalette(BUILTIN_THEMES.lazyvim ?? BUILTIN_THEMES.default).bg), "in the theme's colors");

		assert.equal((await fetch(base + "/api/state")).status, 401);
		assert.equal((await fetch(base + "/api/state", { headers: { authorization: "Bearer wrong-code" } })).status, 401);
		const state = await (await fetch(base + "/api/state", { headers: auth })).json();
		assert.equal(state.project, "shop");
		assert.deepEqual(
			{ ...state.agents[0], version: 0 },
			{
				id: a.id,
				name: "fix the race",
				engine: "claude",
				engineName: "Claude Code",
				model: "claude-fable-5",
				state: "idle",
				branch: "fix/the-race",
				added: 12,
				removed: 3,
				tokens: 74810,
				cost: 0.5,
				queued: 0,
				unread: false,
				version: 0,
				last: { kind: "agent", text: "Found it: two writers race on cart.total. await lock(cart);" },
			},
		);
		assert.equal((await fetch(`${base}/api/state?code=${CODE}`)).status, 200, "reads may carry it in the URL (EventSource)");

		const one = await (await fetch(`${base}/api/agents/${a.id}`, { headers: auth })).json();
		assert.deepEqual(one.items.map((i) => i.kind), ["user", "agent", "tool"]);
		assert.equal(one.items[2].tool.output, "ok 12 tests");
		assert.equal((await fetch(`${base}/api/agents/999`, { headers: auth })).status, 404);

		// prompts and stops: header only, so another page can't send them from your browser
		assert.equal((await post(`/api/agents/${a.id}/prompt?code=${CODE}`, { text: "x" }, {})).status, 401);
		assert.deepEqual(await (await post(`/api/agents/${a.id}/prompt`, { text: "  also check the refunds  " })).json(), { queued: 0 });
		assert.deepEqual(a.sent, ["also check the refunds"]);
		assert.match(notes.at(-1), /'fix the race' got a prompt from your phone/);
		assert.deepEqual(await (await post(`/api/agents/${a.id}/prompt`, { text: "and the docs" })).json(), { queued: 1 }, "running: it waits its turn");
		assert.equal((await post(`/api/agents/${a.id}/prompt`, { text: "" })).status, 400);
		assert.deepEqual(await (await post(`/api/agents/${a.id}/stop`, {})).json(), { state: "idle" });
		assert.equal(a.aborted, 1);

		const started = await (await post("/api/agents", { text: "add retries to checkout" })).json();
		assert.equal(sessions.length, 2);
		assert.equal(started.id, sessions[1].id);
		assert.deepEqual(sessions[1].sent, ["add retries to checkout"]);

		// 10 wrong codes: locked, even for the right one, until :serve starts again
		for (let i = 0; i < 10; i++) await fetch(base + "/api/state", { headers: { authorization: `Bearer nope-${i}` } });
		assert.equal((await fetch(base + "/api/state", { headers: auth })).status, 423);
		assert.match(notes.at(-1), /stopped answering after 10 wrong access codes/);
	} finally {
		await sv.close();
	}
});

test("live updates: the event stream sends the agent list when anything changes", async () => {
	const { a, host } = fakeHost();
	const sv = await startServer(host, { port: 0, host: "127.0.0.1", code: CODE });
	const ctrl = new AbortController();
	try {
		const res = await fetch(`http://127.0.0.1:${sv.port}/api/events?code=${CODE}`, { signal: ctrl.signal });
		assert.equal(res.headers.get("content-type"), "text/event-stream");
		const reader = res.body.getReader();
		let buf = "";
		const nextAgents = async () => {
			while (true) {
				const i = buf.indexOf("\n\n");
				if (i >= 0) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					const data = /^event: agents\ndata: (.*)$/m.exec(block);
					if (data) return JSON.parse(data[1]).agents;
					continue;
				}
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buf += new TextDecoder().decode(value);
			}
		};
		assert.equal((await nextAgents())[0].state, "idle");
		await until(() => sv.clients() === 1);
		a.setState("running");
		assert.equal((await nextAgents())[0].state, "running");
	} finally {
		ctrl.abort();
		await sv.close();
	}
});

test(":serve in vigent: shows where to open it and the code, marks the statusline, :serve stop ends it", async () => {
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const overlays = [];
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const a = new S("fix the race", "m");
	app.addSession(a, true);
	await app.execServe("local 0");
	assert.ok(app.server);
	const screen = plain(overlays.at(-1).render(84));
	assert.match(screen, /Follow from your phone/);
	assert.match(screen, new RegExp(`http://127\\.0\\.0\\.1:${app.server.port}/`));
	assert.match(screen, new RegExp(app.server.code));
	assert.match(screen, /This machine only/);
	assert.match(plain(app.render(120)), /⇄ m /, "the statusline says it's on");

	const r = await fetch(`http://127.0.0.1:${app.server.port}/api/state`, { headers: { authorization: `Bearer ${app.server.code}` } });
	assert.equal((await r.json()).agents[0].name, "fix the race");

	await app.execServe("stop");
	assert.equal(app.server, undefined);
	assert.match(app.message, /:serve stopped/);
	await assert.rejects(fetch(`http://127.0.0.1:${r.url.split(":")[2].split("/")[0]}/`));
});

// a real phone browser, when Playwright is around
const playwright = (() => {
	try {
		return createRequire(import.meta.url)("playwright");
	} catch {
		return undefined;
	}
})();

test("on a phone: type the code, see the agents, open one, send a prompt", { skip: !playwright && "needs playwright", timeout: 60000 }, async () => {
	const { a, host } = fakeHost();
	const sv = await startServer(host, { port: 0, host: "127.0.0.1", code: CODE });
	const browser = await playwright.chromium.launch();
	try {
		const page = await (await browser.newContext({ ...playwright.devices["iPhone 13"] })).newPage();
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto(`http://127.0.0.1:${sv.port}/`);
		await page.fill("#c", "WRONG-CODE");
		await page.click("text=Follow");
		await page.waitForSelector("text=wrong access code");
		await page.fill("#c", CODE.toUpperCase()); // typed on a phone keyboard
		await page.click("text=Follow");
		await page.waitForSelector(".card");
		assert.match(await page.textContent(".card"), /fix the race.*idle.*Claude Code · claude-fable-5 · ⎇ fix\/the-race · \+12 −3 · 74\.8k tok · \$0\.50/s);

		await page.click(".card");
		await page.waitForSelector(".item.agent");
		assert.equal(await page.textContent(".item.agent pre"), "await lock(cart);", "code blocks render");
		assert.equal(await page.textContent(".item.agent code"), "cart.total");
		await page.fill("#t", "also check the refunds");
		await page.click("#go");
		await until(() => a.sent.length === 1);
		assert.deepEqual(a.sent, ["also check the refunds"]);
		await page.waitForSelector("#stop", { timeout: 5000 }); // it runs: Stop shows up, live
		a.items.push({ kind: "agent", text: "Refunds are fine.", streaming: true });
		a.setState("idle");
		await page.waitForSelector("text=Refunds are fine.");
		assert.deepEqual(errors, []);
	} finally {
		await browser.close();
		await sv.close();
	}
});
