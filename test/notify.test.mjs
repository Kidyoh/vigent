import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { applySetCommand, DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { alertSequence, showsDesktopNotifications } from "../dist/notify.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

class S extends Session {
	send() {}
	abort() {}
}

function makeApp(ui = {}) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 30, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, ...ui }, new Keymap());
	const alerts = [];
	app.alert = (bytes) => alerts.push(bytes);
	const a = new S("fix the race", "m");
	const b = new S("add retries", "m");
	app.addSession(a, true);
	app.addSession(b, false);
	return { app, a, b, alerts };
}

test("the bytes: a bell, OSC 9 where the terminal shows it, wrapped for tmux", () => {
	assert.equal(alertSequence("done", "bell", {}), "\x07");
	assert.equal(alertSequence("done", "auto", { TERM_PROGRAM: "Apple_Terminal" }), "\x07", "no desktop notification where OSC 9 isn't shown");
	assert.equal(alertSequence("done", "auto", { TERM_PROGRAM: "iTerm.app" }), "\x07\x1b]9;done\x07");
	assert.equal(alertSequence("done", "desktop", {}), "\x1b]9;done\x07", "desktop: no bell");
	assert.equal(alertSequence("done", "off", { TERM_PROGRAM: "ghostty" }), "");
	assert.equal(alertSequence("a\x1b]evil\x07b", "desktop", {}), "\x1b]9;a ]evil b\x07", "no control characters inside");
	assert.equal(alertSequence("done", "desktop", { TMUX: "/tmp/tmux-0/default,1,0" }), "\x1bPtmux;\x1b\x1b]9;done\x07\x1b\\");
	for (const env of [{ TERM_PROGRAM: "WezTerm" }, { TERM_PROGRAM: "ghostty" }, { KITTY_WINDOW_ID: "1" }, { TERM: "xterm-kitty" }]) {
		assert.equal(showsDesktopNotifications(env), true, JSON.stringify(env));
	}
	assert.equal(showsDesktopNotifications({ TERM: "xterm-256color" }), false);
});

test("an agent you're not looking at finishes: bell, a message, and a mark in the sidebar until you open it", () => {
	const { app, b, alerts } = makeApp({ notify: "bell" });
	b.setState("running");
	assert.deepEqual(alerts, [], "starting isn't news");
	b.setState("idle");
	assert.deepEqual(alerts, ["\x07"]);
	assert.ok(app.unread.has(b));
	assert.match(app.message, /'add retries' finished · <Space>2 or \]s to open it/);
	assert.match(plain(app.render(120)), /add retries ◆/);

	app.handleInput(" "); // open it
	app.handleInput("2");
	assert.equal(app.focusedSession, b);
	assert.ok(!app.unread.has(b));
	assert.doesNotMatch(plain(app.render(120)), /◆/);
});

test("failed and needs-you say so; pausing doesn't notify", () => {
	const { app, b, alerts } = makeApp({ notify: "bell" });
	b.setState("running");
	b.setState("error");
	assert.match(app.message, /'add retries' failed/);
	b.setState("running");
	b.setState("waiting");
	assert.match(app.message, /'add retries' needs you/);
	assert.equal(alerts.length, 2);
	b.setState("running");
	b.pause();
	assert.equal(alerts.length, 2, "you paused it: no news");
});

test("the agent on screen only notifies when the terminal window isn't focused", () => {
	const { app, a, alerts } = makeApp({ notify: "bell" });
	a.setState("running");
	a.setState("idle");
	assert.deepEqual(alerts, [], "you watched it finish");
	app.handleInput("\x1b[O"); // the window lost focus
	assert.equal(app.terminalFocused, false);
	a.setState("running");
	a.setState("idle");
	assert.deepEqual(alerts, ["\x07"]);
	assert.ok(app.unread.has(a));
	app.handleInput("\x1b[I"); // back
	assert.ok(!app.unread.has(a), "seeing it counts as reading it");
	assert.equal(app.mode, "NORMAL", "focus reports aren't keys");
});

test("notify is an option: config, :set, off", () => {
	const ui = { ...DEFAULT_UI };
	assert.equal(ui.notify, "auto");
	applySetCommand(ui, "notify=desktop");
	assert.equal(ui.notify, "desktop");
	assert.match(applySetCommand(ui, "notify=loud").message, /should be "auto", "bell", "desktop" or "off"/);
	const { b, alerts } = makeApp({ notify: "off" });
	b.setState("running");
	b.setState("idle");
	assert.deepEqual(alerts, [""], "off writes nothing");
});
