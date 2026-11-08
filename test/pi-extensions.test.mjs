/**
 * pi's extensions, skills and prompt templates in a real pi agent, with a
 * stand-in model (pi's faux provider). The permission gate is pi's own example.
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
import { PiSession } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-piext-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const until = async (fn, ms = 10000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};

// pi's config folder: two extensions, a skill, a prompt template
const agentDir = path.join(tmp, "agent");
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
fs.writeFileSync(path.join(agentDir, "extensions", "typo.ts"), "export default function (pi) { this is not javascript }\n");
fs.mkdirSync(path.join(agentDir, "skills", "changelog"), { recursive: true });
fs.writeFileSync(path.join(agentDir, "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: Write a changelog entry from the diff\n---\nRead the diff and write a changelog entry.\n");
fs.mkdirSync(path.join(agentDir, "prompts"));
fs.writeFileSync(path.join(agentDir, "prompts", "tidy.md"), "---\ndescription: Tidy the code you touched\n---\nTidy the code in $1 without changing behavior.\n");

const repo = path.join(tmp, "repo");
fs.mkdirSync(path.join(repo, "build"), { recursive: true });
fs.writeFileSync(path.join(repo, "build", "app.js"), "built\n");
fs.writeFileSync(path.join(repo, "AGENTS.md"), "Run npm test before finishing.\n");
execFileSync("git", ["init", "-q"], { cwd: repo });

async function setup() {
	const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { registerFauxProvider } = await import("@mariozechner/pi-ai");
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "test");
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide: () => overlays.splice(overlays.indexOf(c), 1) }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	app.alert = () => {};
	const s = new PiSession("ship it", "faux", { cwd: repo, modelObject: faux.getModel(), authStorage, agentDir });
	app.addSession(s, true);
	await s.ready;
	return { app, s, faux, overlays };
}

test("extensions start with a UI: their commands run, notify reaches you, setStatus shows in the winbar, load errors are named", async () => {
	const { app, s, faux } = await setup();
	try {
		assert.match(plain(app.render(120)), /▸ ship it .*deploy: ready/, "session_start ran and set a status");
		assert.ok(s.items.some((i) => i.kind === "info" && /extension extensions\/typo\.ts didn't load/.test(i.text)));

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
		assert.equal(s.state, "idle", "a command that runs no turn leaves the agent idle");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test("pi's permission gate asks before rm -rf: No blocks the command, Yes lets it run", async () => {
	const { fauxAssistantMessage, fauxToolCall } = await import("@mariozechner/pi-ai");
	const { app, s, faux, overlays } = await setup();
	try {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf build" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("I left the build folder alone."),
		]);
		s.send("clean the build");
		await until(() => overlays.length === 1);
		const screen = plain(overlays[0].render(100));
		assert.match(screen, /'ship it' · ⚠ Dangerous command: rm -rf build Allow\?/);
		assert.match(screen, /Yes/);
		overlays[0].handleInput("j");
		overlays[0].handleInput("\r"); // No
		await until(() => s.state === "idle");
		assert.ok(fs.existsSync(path.join(repo, "build", "app.js")), "blocked");
		assert.match(s.items.find((i) => i.kind === "tool").tool.output, /Blocked by user/);

		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf build" }), { stopReason: "toolUse" }), fauxAssistantMessage("Removed it.")]);
		s.send("clean it now");
		await until(() => overlays.length === 1);
		overlays[0].handleInput("\r"); // Yes
		await until(() => s.state === "idle" && s.items.at(-1).text === "Removed it.");
		assert.ok(!fs.existsSync(path.join(repo, "build")), "allowed");
	} finally {
		s.dispose();
		faux.unregister();
	}
});

test(":pi lists what pi loaded; Enter on a command, skill or prompt starts a prompt with it", async () => {
	const { app, s, faux, overlays } = await setup();
	try {
		[":", "p", "i", "\r"].forEach((k) => app.handleInput(k));
		const float = overlays.at(-1);
		const screen = plain(float.render(96));
		assert.match(screen, /pi · ship it/);
		assert.match(screen, /Extensions {2}3/);
		assert.match(screen, /permission-gate\.ts/);
		assert.match(screen, /typo\.ts {2}.+/, "the one that failed, with why");
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
