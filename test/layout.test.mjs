import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { applySetCommand, DEFAULT_UI, loadConfig } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { DEFAULT_LAYOUT } from "../dist/layout.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";
import { Tty } from "./support/terminal.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-layout-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, text) => {
	const f = path.join(tmp, name);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, text);
	return f;
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

class S extends Session {
	send(t) {
		this.pushUser(t);
	}
	abort() {}
}

function makeApp(ui = {}, layout) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 20, columns: 110, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, ...ui }, new Keymap(), { config: { enabled: true } });
	if (layout) app.layout = layout;
	for (const name of ["cart total", "docs pass"]) {
		const s = new S(name, "claude-sonnet-4-5", { branch: `fix/${name.replace(" ", "-")}`, path: `/wt/${name}` }); // short and fixed: a temp path (macOS: /private/var/folders/…) would push parts off the line
		s.engine = "claude";
		s.effort = "high";
		app.addSession(s, false);
	}
	app.focusIdx = 0;
	const lines = () => app.render(110).map(strip);
	const type = (...keys) => keys.forEach((k) => app.handleInput(k));
	return { app, lines, type };
}

test("[statusline], [winbar] and sidebar_position in config.toml; mistakes are warnings", () => {
	const f = write(
		"config.toml",
		`[ui]\nsidebar_position = "right"\n[statusline]\nleft = ["mode", "branch", "weather"]\nright = ["engine", "clock"]\n[winbar]\nleft = ["agent"]\nright = "path"\ncenter = []\n`,
	);
	const { config, warnings } = loadConfig(f);
	assert.equal(config.ui.sidebar_position, "right");
	assert.deepEqual(config.layout.statusline, { left: ["mode", "branch"], right: ["engine", "clock"] });
	assert.deepEqual(config.layout.winbar, { left: ["agent"], right: DEFAULT_LAYOUT.winbar.right }, "a bad list keeps the default");
	assert.deepEqual(warnings, [
		"config [statusline]: unknown part 'weather' (mode, agent, branch, engine, model, effort, usage, agents, path, clock)",
		`config [winbar]: 'right' should be a list, e.g. ["agent", "model"]`,
		"config [winbar]: unknown option 'center' (left, right)",
	]);
	assert.deepEqual(loadConfig(write("bad.toml", `[ui]\nsidebar_position = "top"\n`)).warnings, [`config [ui]: 'sidebar_position' should be "left" or "right"`]);

	const ui = { ...DEFAULT_UI };
	applySetCommand(ui, "sbp=right");
	assert.equal(ui.sidebar_position, "right");
	assert.match(applySetCommand(ui, "sidebar_position?").message, /sidebar_position=right/);
	applySetCommand(ui, "sidebar_position&");
	assert.equal(ui.sidebar_position, "left");
});

test("the default statusline and winbar", () => {
	const { lines } = makeApp();
	const l = lines();
	assert.match(l[0], /▸ cart total {2}Claude Code · claude-sonnet-4-5 · high\s*$/);
	assert.match(l.at(-2), /^ NORMAL {2}cart total ⎇ fix\/cart-total +claude-sonnet-4-5 {2}0 tok {2}0\/2 $/);
});

test("the default winbar doesn't show where the worktree is", () => {
	const { lines } = makeApp();
	const winbar = lines()[0].split("│")[1];
	assert.doesNotMatch(winbar, /wt\/|this checkout|✦/);
});

test("the parts you pick, in your order", () => {
	const { lines } = makeApp({}, {
		statusline: { left: ["agent", "engine", "mode"], right: ["effort", "path", "clock"] },
		winbar: { left: ["branch", "status"], right: ["usage", "engine"] },
	});
	const l = lines();
	assert.match(l.at(-2), /^ cart total {2}Claude Code {2}NORMAL +high {2}.*wt\/cart total {2}\d\d:\d\d $/);
	const winbar = l[0].split("│")[1];
	assert.match(winbar, /^ ⎇ fix\/cart-total +0 tok {2}Claude Code $/, "no agent part: the winbar starts with the branch");
	assert.doesNotMatch(winbar, /▸/);
});

test("sidebar_position = right: the sidebar on the right, and the window keys follow it", () => {
	const { app, lines, type } = makeApp({ sidebar_position: "right" });
	const l = lines();
	assert.match(l[0], /^ ▸ cart total .*│.*SESSIONS/, "transcript first, then the sidebar");
	type("\x0c"); // <C-l>: toward the sidebar
	assert.equal(app.sidebarFocused, true);
	type("\x0c");
	assert.equal(app.sidebarFocused, true, "<C-l> in the sidebar stays there");
	type("\x08"); // <C-h>: back
	assert.equal(app.sidebarFocused, false);
	type("\x17", "l");
	assert.equal(app.sidebarFocused, true, "<C-w>l moves into it");
	type("\x17", "h");
	assert.equal(app.sidebarFocused, false, "<C-w>h comes back");
});

test("the real vigent with the sidebar on the right and a statusline of your own", { timeout: 60000 }, async () => {
	write("xdg/vigent/config.toml", `[ui]\nsidebar_position = "right"\n[statusline]\nleft = ["mode", "engine"]\nright = ["agents", "clock"]\n`);
	const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, "xdg"), XDG_STATE_HOME: path.join(tmp, "state"), TERM: "xterm-256color" };
	const t = new Tty(["--demo"], { cwd: tmp, env, cols: 130, rows: 30 });
	try {
		await t.waitFor(/SESSIONS/);
		await t.waitFor(/\d+\/\d+ +\d\d:\d\d/);
		const rows = t.screen().split("\n");
		const top = rows.find((r) => /SESSIONS/.test(r));
		assert.ok(top.indexOf("SESSIONS") > 80, "the sidebar is on the right");
	} finally {
		t.kill();
	}
});
