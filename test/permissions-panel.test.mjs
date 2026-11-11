import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { CliSession } from "../dist/cli-engines.js";
import { DEFAULT_UI, loadConfig } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { codexOption, flagValue, withCodexOption, withFlag, withSwitch } from "../dist/permissions.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-perms-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("helpers change only the permission part of an engine's arguments", () => {
	const args = ["--verbose", "--permission-mode", "acceptEdits", "--add-dir", "/x"];
	assert.equal(flagValue(args, "--permission-mode"), "acceptEdits");
	assert.deepEqual(withFlag(args, "--permission-mode", "plan"), ["--verbose", "--add-dir", "/x", "--permission-mode", "plan"], "yours kept");
	assert.deepEqual(withFlag(["--permission-mode=plan"], "--permission-mode", undefined), []);
	assert.deepEqual(withSwitch(["--x"], "--force", true), ["--x", "--force"]);
	assert.deepEqual(withSwitch(["--force", "--x"], "--force", false), ["--x"]);

	const codex = ["-c", 'sandbox_mode="workspace-write"', "-c", "model_verbosity=low"];
	assert.equal(codexOption(codex, "sandbox_mode"), "workspace-write");
	assert.deepEqual(withCodexOption(codex, "sandbox_workspace_write.network_access", true), [...codex, "-c", "sandbox_workspace_write.network_access=true"]);
	assert.deepEqual(withCodexOption(codex, "sandbox_mode", "read-only"), ["-c", "model_verbosity=low", "-c", 'sandbox_mode="read-only"']);
	assert.deepEqual(withCodexOption(codex, "model_verbosity", undefined), ["-c", 'sandbox_mode="workspace-write"']);
});

function makeApp() {
	const overlays = [];
	const tui = { requestRender() {}, showOverlay: (c) => (overlays.push(c), { hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 130, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap());
	const ex = (cmd) => [":", ...cmd, "\r"].forEach((k) => app.handleInput(k));
	return { app, overlays, ex };
}

/** select the panel row with this label, then press the keys */
const press = (panel, label, ...keys) => {
	const i = panel.items.findIndex((it) => it.label === label);
	assert.ok(i >= 0, `row '${label}'`);
	panel.index = i;
	for (const k of keys) panel.handleInput(k);
};

test(":permissions toggles each agent's permissions; agents use them from their next prompt; each change is saved at once", async () => {
	const { app, overlays, ex } = makeApp();
	const engines = (app.engineOptions = {}); // shared with the CLI, as cli.ts does
	ex("permissions");
	const panel = overlays.at(-1);
	const screen = () => strip(panel.render(120).join("\n"));
	assert.match(screen(), /Claude Code[\s\S]*Mode\s+acceptEdits[\s\S]*Codex[\s\S]*Sandbox\s+workspace-write[\s\S]*Network \(fetch, git, gh\)\s+off[\s\S]*Gemini CLI[\s\S]*Approval\s+auto_edit[\s\S]*Cursor CLI[\s\S]*Run commands without asking\s+on/, "today's defaults");

	press(panel, "Mode", " ");
	assert.deepEqual(engines.claude.args, ["--permission-mode", "default"]);
	press(panel, "Mode", " ", " ");
	assert.deepEqual(engines.claude.args, ["--permission-mode", "bypassPermissions"]);
	press(panel, "Ask when it's refused a tool", " ");
	assert.equal(engines.claude.ask, true);
	press(panel, "Allow GitHub CLI (gh)", " ");
	press(panel, "Allow fetch web pages", " ");
	assert.deepEqual(engines.claude.allow, ["Bash(gh:*)", "WebFetch"]);
	assert.match(screen(), /Allow GitHub CLI \(gh\)\s+on {2}Bash\(gh:\*\)/);

	press(panel, "Network (fetch, git, gh)", " ");
	assert.deepEqual(engines.codex.args, ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"]);
	press(panel, "Approval", " ");
	assert.deepEqual(engines.gemini.args, ["--approval-mode", "yolo"]);
	press(panel, "Run commands without asking", " ");
	assert.deepEqual(engines.cursor.args, []);

	// an agent that's already open runs with them from its next prompt
	const log = path.join(tmp, "argv.log");
	const bin = path.join(tmp, "claude");
	fs.writeFileSync(bin, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	fs.chmodSync(bin, 0o755);
	const s = new CliSession("racer", "claude", undefined, { cwd: tmp, bin, extraArgs: () => engines.claude?.args, allow: () => engines.claude?.allow, ask: () => engines.claude?.ask });
	assert.equal(s.asksToAllow, true);
	s.send("go");
	for (let i = 0; i < 200 && s.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
	const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1));
	assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
	assert.deepEqual(argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--allowedTools") + 3), ["Bash(gh:*)", "WebFetch"]);

	// no w needed: every change was written as it was made
	const file = path.join(tmp, "xdg", "vigent", "config.toml");
	const { config, warnings } = loadConfig(file);
	assert.deepEqual(warnings, []);
	assert.deepEqual(config.engines.claude, { args: ["--permission-mode", "bypassPermissions"], allow: ["Bash(gh:*)", "WebFetch"], ask: true });
	assert.deepEqual(config.engines.codex.args, ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"]);
	assert.deepEqual(config.engines.gemini.args, ["--approval-mode", "yolo"]);
	assert.deepEqual(config.engines.cursor.args, []);
});

test(":permissions allow <rule> / remove <rule>; :settings links to the panel", () => {
	const { app, overlays, ex } = makeApp();
	app.engineOptions = { claude: { allow: ["Bash(gh:*)"] } };
	ex("permissions allow Bash(cargo:*)");
	assert.deepEqual(app.engineOptions.claude.allow, ["Bash(gh:*)", "Bash(cargo:*)"]);
	assert.deepEqual(loadConfig(path.join(tmp, "xdg", "vigent", "config.toml")).config.engines.claude.allow, ["Bash(gh:*)", "Bash(cargo:*)"], "saved, so it's still allowed after a restart");
	assert.match(app.message, /saved; from its next prompt/);
	assert.match(app.message, /allowed Bash\(cargo:\*\) for Claude Code/);
	ex("permissions remove Bash(gh:*)");
	assert.deepEqual(app.engineOptions.claude.allow, ["Bash(cargo:*)"]);
	ex("permissions allow WebFetch Bash(npm run test:*)");
	assert.deepEqual(app.engineOptions.claude.allow, ["Bash(cargo:*)", "WebFetch", "Bash(npm run test:*)"], "several at once, spaces inside a rule kept");
	ex("permissions remove WebFetch Bash(npm run test:*)");
	ex("perm");
	assert.match(strip(overlays.at(-1).render(120).join("\n")), /Other allowed\s+Bash\(cargo:\*\)/);
	ex("permissions sideways");
	assert.match(app.message, /usage: :permissions/);

	ex("settings");
	const settings = overlays.at(-1);
	press(settings, "Permissions", "\r");
	assert.match(strip(overlays.at(-1).render(120).join("\n")), /Ask when it's refused a tool/, "Enter on Permissions opens the panel");
});

test("two vigents open at once: a permission changed in one isn't undone by the other", { timeout: 60000 }, async () => {
	const home = path.join(tmp, "two");
	const repo = (name) => {
		const dir = path.join(home, name);
		fs.mkdirSync(dir, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
		return dir;
	};
	const xdg = path.join(home, "xdg");
	const env = { ...process.env, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: path.join(home, "state"), RIFTRI_BINARY: path.join(home, "none"), TERM: "xterm-256color" };
	const file = path.join(xdg, "vigent", "config.toml");
	const saved = () => (fs.existsSync(file) ? loadConfig(file).config.engines.claude ?? {} : {});
	const until = async (ok, what) => {
		for (const end = Date.now() + 10000; Date.now() < end; ) {
			if (ok(saved())) return;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.fail(`config.toml never had ${what}: ${JSON.stringify(saved())}`);
	};
	// "old" opened first, so it read the config before "new" changed it
	const old = new Tty([], { cwd: repo("old"), env, cols: 130, rows: 40 });
	const now = new Tty([], { cwd: repo("new"), env, cols: 130, rows: 40 });
	try {
		await old.waitFor(/NORMAL/);
		await now.waitFor(/NORMAL/);
		await now.ex("permissions");
		await now.waitFor(/Ask when it's refused a tool/);
		await now.type("j\r"); // ask: on
		await now.type("j\r"); // allow gh
		await until((c) => c.ask === true && c.allow?.includes("Bash(gh:*)"), "ask and gh");

		await old.ex("permissions allow Bash(cargo:*)");
		await until((c) => c.allow?.includes("Bash(cargo:*)"), "cargo");
		assert.deepEqual(saved(), { allow: ["Bash(gh:*)", "Bash(cargo:*)"], ask: true }, "the other vigent's rule and asking are kept");

		await old.ex("permissions");
		await old.waitFor(/Allow GitHub CLI \(gh\)\s+on/); // the panel shows what's saved now
		await old.type("jjjj\r"); // allow npm
		await until((c) => c.allow?.includes("Bash(npm:*)"), "npm");
		assert.deepEqual(saved(), { allow: ["Bash(gh:*)", "Bash(cargo:*)", "Bash(npm:*)"], ask: true });
	} finally {
		old.kill();
		now.kill();
	}
});
