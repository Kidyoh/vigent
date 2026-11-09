/**
 * pi's extensions, skills and prompt templates in a real pi agent (your pi in
 * RPC mode), with a stand-in model server. The permission gate is pi's own example.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { PiSession } from "../dist/pi-session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-piext-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
import { realPi, until } from "./support/pi.mjs";

// pi's config folder (made by realPi), with two extensions, a skill, a prompt template
function addResources(agentDir) {
fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
fs.copyFileSync(
	path.join(import.meta.dirname, "..", "node_modules", "@mariozechner", "pi-coding-agent", "examples", "extensions", "permission-gate.ts"),
	path.join(agentDir, "extensions", "permission-gate.ts"),
);
fs.writeFileSync(
	path.join(agentDir, "extensions", "deploy.ts"),
	`export default function (pi) {
	pi.on("session_start", async (_event, ctx) => ctx.ui.setStatus("deploy", "deploy: ready"));
	pi.registerCommand("hello", { description: "Say hello", handler: async (args, ctx) => ctx.ui.notify(\`Hello \${args || "world"}!\`, "info") });
	pi.registerCommand("deploy", {
		description: "Deploy, after asking",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Deploy", "ship it to production?");
			ctx.ui.notify(ok ? "deploying" : "not deploying", ok ? "info" : "warning");
		},
	});
	pi.registerCommand("broken", { description: "Throws", handler: async () => { throw new Error("kaboom"); } });
}
`,
);
fs.mkdirSync(path.join(agentDir, "skills", "changelog"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: Write a changelog entry from the diff\n---\nRead the diff and write a changelog entry.\n");
fs.mkdirSync(path.join(agentDir, "prompts"));
fs.writeFileSync(path.join(agentDir, "prompts", "tidy.md"), "---\ndescription: Tidy the code you touched\n---\nTidy the code in $1 without changing behavior.\n");
}

const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "build"), { recursive: true });
fs.writeFileSync(path.join(repo, "build", "app.js"), "built\n");
fs.writeFileSync(path.join(repo, "AGENTS.md"), "Run npm test before finishing.\n");
execFileSync("git", ["init", "-q"], { cwd: repo });

async function setup(script = []) {
	const faux = await realPi(tmp, script);
	addResources(faux.agentDir);
	faux.unregister = faux.close;
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide: () => overlays.splice(overlays.indexOf(c), 1) }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.alert = () => {};
	const s = new PiSession("ship it", "default", { cwd: repo, env: faux.env });
	app.addSession(s, true);
	await s.ready;
	return { app, s, faux, overlays };
}

test("extensions start with a UI: their commands run, notify reaches you, setStatus shows in the winbar", async () => {
	const { app, s, faux } = await setup();
	try {
		await until(() => /▸ ship it .*deploy: ready/.test(plain(app.render(120))), 10000, "session_start's status");

		s.send("/hello vigent");
		await until(() => s.state === "idle" && s.items.some((i) => i.text === "Hello vigent!"));
		assert.match(app.message, /'ship it': Hello vigent!/);

		s.send("/broken");
		await until(() => s.items.some((i) => /extension error .*kaboom/.test(i.text)));
		await until(() => s.state !== "running");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test("confirm() is a y/n question in vigent's command line", async () => {
	const { app, s, faux } = await setup();
	try {
		s.send("/deploy");
		await until(() => /'ship it' Deploy: ship it to production\? \(y\/n\)/.test(plain(app.render(120))));
		app.handleInput("\x1b[I"); // a focus report is not an answer
		assert.match(plain(app.render(120)), /\(y\/n\)/);
		app.handleInput("y");
		await until(() => s.items.some((i) => i.text === "deploying"));

		s.send("/deploy");
		await until(() => /\(y\/n\)/.test(plain(app.render(120))));
		app.handleInput("n");
		await until(() => s.items.some((i) => i.text === "not deploying"));
		// the command's notify arrives before pi's reply to the prompt; vigent goes idle once that's in
		await until(() => s.state !== "running", 10000, "the agent to settle");
		assert.equal(s.state, "idle", "a command that runs no turn leaves the agent idle");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test("pi's permission gate asks before rm -rf: No blocks the command, Yes lets it run", async () => {
	const { app, s, faux, overlays } = await setup([
		{ tool: "bash", args: { command: "rm -rf build" } },
		{ text: "I left the build folder alone." },
		{ tool: "bash", args: { command: "rm -rf build" } },
		{ text: "Removed it." },
	]);
	try {
		s.send("clean the build");
		await until(() => overlays.length === 1, 15000, "the gate's question");
		assert.equal(s.state, "waiting", "the agent waits for you");
		const screen = plain(overlays[0].render(100));
		assert.match(screen, /'ship it' · ⚠ Dangerous command: rm -rf build Allow\?/);
		assert.match(screen, /Yes/);
		overlays[0].handleInput("j");
		overlays[0].handleInput("\r"); // No
		await until(() => s.state === "idle", 15000, "the run to end");
		assert.ok(fs.existsSync(path.join(repo, "build", "app.js")), "blocked");
		assert.match(s.items.find((i) => i.kind === "tool").tool.output, /Blocked by user/);

		s.send("clean it now");
		await until(() => overlays.length === 1, 15000, "the gate's question");
		overlays[0].handleInput("\r"); // Yes
		await until(() => s.state === "idle" && s.items.at(-1).text === "Removed it.", 15000, "the reply");
		assert.ok(!fs.existsSync(path.join(repo, "build")), "allowed");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test("an extension that doesn't load stops pi; the agent says which and why", async () => {
	const pi = await realPi(tmp);
	fs.mkdirSync(path.join(pi.agentDir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(pi.agentDir, "extensions", "typo.ts"), "export default function (pi) { this is not javascript }\n");
	const s = new PiSession("broken", "default", { cwd: repo, env: pi.env });
	try {
		await assert.rejects(s.ready, /pi stopped \(exit 1\).*typo\.ts/s);
		assert.ok(s.items.some((i) => /error: pi stopped \(exit 1\).*Failed to load extension.*typo\.ts/s.test(i.text)));
	} finally {
		s.dispose();
		await pi.close();
	}
});

test(":pi lists what pi loaded; Enter on a command, skill or prompt starts a prompt with it", async () => {
	const { app, s, faux, overlays } = await setup();
	try {
		[":", "p", "i", "\r"].forEach((k) => app.handleInput(k));
		const float = overlays.at(-1);
		// wide enough for a long temp path (macOS: /var/folders/…), which a narrow float cuts off
		const screen = plain(float.render(200));
		assert.match(screen, /pi · ship it/);
		assert.match(screen, /Extensions {2}1/, "the ones with commands (the gate has none)");
		assert.match(screen, /deploy\.ts/);
		assert.match(screen, /\/hello +Say hello/);
		assert.match(screen, /\/deploy +Deploy, after asking/);
		assert.match(screen, /\/skill:changelog +Write a changelog entry from the diff/);
		assert.match(screen, /\/tidy +Tidy the code you touched/);
		assert.match(screen, /Context files {2}1/);
		assert.match(screen, /AGENTS\.md/);

		float.handleInput("\r"); // the first command
		assert.equal(app.mode, "INSERT");
		assert.match(app.inputBuf, /^\/\w+ $/);
	} finally {
		s.dispose();
		faux.unregister();
	}
});
