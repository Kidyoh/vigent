import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { flattenTree, TREE_GLYPHS } from "../dist/tree.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-tree-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const msg = (id, parentId, role, content) => ({ entry: { id, parentId, type: "message", message: { role, content } }, children: [] });
function link(nodes) {
	const byId = new Map(nodes.map((n) => [n.entry.id, n]));
	const roots = [];
	for (const n of nodes) (n.entry.parentId ? byId.get(n.entry.parentId).children : roots).push(n);
	return roots;
}

test("flattening: straight runs stay flat, branches get guides, tool results fold away", () => {
	const roots = link([
		msg("u1", null, "user", "fix the race"),
		msg("a1", "u1", "assistant", [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }]),
		msg("r1", "a1", "toolResult", [{ type: "text", text: "1 failing" }]),
		msg("a2", "r1", "assistant", [{ type: "text", text: "Found it:\n```js\nawait x\n```" }]),
		msg("u2", "a2", "user", "add a retry"),
		msg("a3", "u2", "assistant", [{ type: "text", text: "Added a retry." }]),
		msg("u3", "a2", "user", "use waitFor instead"),
		msg("a4", "u3", "assistant", [{ type: "text", text: "Switched to waitFor." }]),
		{ entry: { id: "m1", parentId: "a4", type: "model_change" }, children: [] },
	]);
	const rows = flattenTree(roots, "m1");
	assert.deepEqual(
		rows.map((r) => `${r.guide}${r.kind}:${r.text}${r.current ? " *" : ""}${r.onPath ? "" : " (off)"}`),
		[
			"user:fix the race",
			"tool:bash npm test",
			"agent:Found it: [code]",
			"├─ user:add a retry (off)",
			"│  agent:Added a retry. (off)",
			"└─ user:use waitFor instead",
			"   agent:Switched to waitFor. *",
		],
		"the model change is skipped and 'here' moves to the reply above it",
	);
	assert.deepEqual(
		flattenTree(roots, "a3", TREE_GLYPHS.ascii).map((r) => r.guide),
		["", "", "", "|- ", "|  ", "`- ", "   "],
	);
	assert.equal(flattenTree(roots, "a3").find((r) => r.current).id, "a3");
	assert.deepEqual(flattenTree([], null), []);
});

test("a pi agent branches: back to a prompt, edit and resend; old branches stay, even after a restart", async () => {
	const { PiSession } = await import("../dist/session.js");
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { registerFauxProvider, fauxAssistantMessage } = await import("@mariozechner/pi-ai");
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "test");
	const seen = [];
	const reply = (text) => (context) => {
		seen.push(context.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content[0].text)));
		return fauxAssistantMessage(text);
	};
	const opts = {
		cwd: tmp,
		modelObject: faux.getModel(),
		authStorage,
		agentDir: path.join(tmp, "pi"),
		sessionDir: path.join(tmp, "sessions"),
	};
	const run = (s, prompt) =>
		new Promise((resolve) => {
			const off = s.onChange(() => {
				if (s.state === "idle" && s.items.at(-1)?.kind === "agent" && !s.items.at(-1).streaming) {
					off();
					resolve();
				}
			});
			s.send(prompt);
		});

	const s = new PiSession("racer", "faux", opts);
	await s.ready;
	faux.setResponses([reply("a"), reply("b"), reply("b2"), reply("c")]);
	await run(s, "A");
	await run(s, "B");

	let rows = s.tree();
	const promptB = rows.find((r) => r.kind === "user" && r.text === "B");
	const { editorText } = await s.navigate(promptB.id);
	assert.equal(editorText, "B", "going back to a prompt hands it back for editing");
	assert.deepEqual(s.items.map((i) => i.text), ["A", "a"], "the transcript is the branch we're on");

	await run(s, "B2");
	assert.deepEqual(seen.at(-1), ["A", "B2"], "the model never sees the abandoned prompt");
	rows = s.tree();
	assert.deepEqual(
		rows.map((r) => `${r.guide}${r.text}${r.current ? " *" : ""}`),
		["A", "a", "├─ B", "│  b", "└─ B2", "   b2 *"],
	);

	const replyA = rows.find((r) => r.text === "a");
	assert.deepEqual(await s.navigate(replyA.id), { editorText: undefined }, "going back to a reply continues from it");
	await run(s, "C");
	assert.deepEqual(seen.at(-1), ["A", "C"]);
	assert.equal(s.tree().filter((r) => r.kind === "user").length, 4);
	s.dispose();

	// restart: every branch is still in the session file
	const again = new PiSession("racer", "faux", opts);
	try {
		await again.ready;
		const texts = again.tree().map((r) => r.text);
		for (const t of ["A", "B", "B2", "C", "b", "b2", "c"]) assert.ok(texts.includes(t), `${t} survives a restart`);
	} finally {
		again.dispose();
		faux.unregister();
	}
});

test("the app: :tree, then Enter on a prompt opens it for editing", async () => {
	const { App } = await import("../dist/app.js");
	const { DEFAULT_UI } = await import("../dist/config.js");
	const { Keymap } = await import("../dist/keys.js");
	const { Session } = await import("../dist/session.js");
	const { BUILTIN_THEMES, Painter } = await import("../dist/theme.js");
	const navigated = [];
	class TreeSession extends Session {
		send() {}
		abort() {}
		tree() {
			return [
				{ id: "u1", guide: "", kind: "user", text: "fix it", onPath: true, current: false },
				{ id: "a1", guide: "", kind: "agent", text: "done", onPath: true, current: true },
			];
		}
		async navigate(id) {
			navigated.push(id);
			return { editorText: id === "u1" ? "fix it" : undefined };
		}
	}
	class Plain extends Session {
		send() {}
		abort() {}
	}
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 110, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.addSession(new TreeSession("t", "m"), true);
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));

	ex("tree");
	const out = overlays[0].render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(out, /Tree · t · 1 prompt · no branches yet/);
	assert.match(out, /done {2}● here/);
	overlays[0].handleInput("k");
	overlays[0].handleInput("\r");
	await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(navigated, ["u1"]);
	assert.equal(app.mode, "INSERT");
	assert.equal(app.inputBuf, "fix it");
	assert.match(app.message, /editing an earlier prompt/);

	app.handleInput("\x1b");
	[" ", "u"].forEach((k) => app.handleInput(k));
	assert.equal(overlays.length, 2, "<leader>u opens it too");

	app.addSession(new Plain("demo", "m"), true);
	ex("tree");
	assert.match(app.message, /has no conversation tree/);
});

test("a prompt sent the moment a pi run ends isn't rejected as 'already processing'", async () => {
	const { PiSession } = await import("../dist/session.js");
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { registerFauxProvider, fauxAssistantMessage } = await import("@mariozechner/pi-ai");
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "test");
	faux.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
	const s = new PiSession("q", "faux", { cwd: tmp, modelObject: faux.getModel(), authStorage, agentDir: path.join(tmp, "pi2") });
	try {
		await s.ready;
		let sentSecond = false;
		const done = new Promise((resolve) => {
			s.onChange(() => {
				// pi emits agent_end before it accepts a new prompt; send right then
				if (!sentSecond && s.state === "idle" && s.items.at(-1)?.text === "first done") {
					sentSecond = true;
					s.send("two");
				}
				if (s.state === "error" || s.items.some((i) => i.text === "second done")) resolve();
			});
		});
		s.send("one");
		await done;
		assert.notEqual(s.state, "error", s.items.map((i) => i.text).join(" | "));
		assert.deepEqual(s.items.map((i) => i.text), ["one", "first done", "two", "second done"]);
	} finally {
		s.dispose();
		faux.unregister();
	}
});
