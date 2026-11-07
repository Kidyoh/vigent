import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { buildKeymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

class TestSession extends Session {
	sent = [];
	send(text) {
		this.sent.push(text);
	}
	abort() {}
}

function makeApp(keys = {}, leader = "<Space>") {
	const overlays = [];
	const tui = {
		requestRender() {},
		showOverlay(component) {
			overlays.push(component);
			return { hide() {} };
		},
	};
	const terminal = { rows: 30, columns: 110 };
	const { keymap, warnings } = buildKeymap(leader, keys);
	assert.deepEqual(warnings, []);
	const app = new App(tui, terminal, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, timeoutlen: 30 }, keymap);
	for (const name of ["one", "two", "three"]) app.addSession(new TestSession(name, "m"), false);
	app.focusIdx = 0;
	const type = (...inputs) => {
		for (const i of inputs) app.handleInput(i);
	};
	const ex = (cmd) => type(":", ...cmd, "\r");
	return { app, type, ex, overlays };
}

test("config mappings drive the app", () => {
	const { app, type } = makeApp({
		normal: { "<Tab>": "session.next", "<leader>t": ":colorscheme nord<CR>", q: false },
		insert: { jk: "<Esc>" },
	});
	type("\t");
	assert.equal(app.focusIdx, 1);
	type(" ", "t");
	assert.equal(app.painter.theme.name, "nord");

	type("i", ..."hi", "j", "k");
	assert.equal(app.mode, "NORMAL", "jk leaves INSERT");
	type("i", "\r");
	assert.deepEqual(app.sessions[1].sent, ["hi"], "the prompt survives Esc, like vim");

	type("q");
	assert.equal(app.message, "", "q = false disables the quit hint");
});

test("built-in keys still work with no config", () => {
	const { app, type } = makeApp();
	type("]", "s");
	assert.equal(app.focusIdx, 1);
	type("3");
	assert.equal(app.focusIdx, 2);
	type("\x1e");
	assert.equal(app.focusIdx, 1, "Ctrl-^ goes back");
	type("q");
	assert.match(app.message, /:q/);
	type("i", ..."one two", "\x17");
	assert.equal(app.inputBuf, "one ", "Ctrl-w deletes a word");
});

test(":nmap, :imap, :nunmap and :let mapleader at runtime", () => {
	const { app, type, ex } = makeApp();
	ex("nmap J session.next");
	type("J");
	assert.equal(app.focusIdx, 1);
	ex("nunmap J");
	type("J");
	assert.equal(app.focusIdx, 1);

	ex('let mapleader = ","');
	ex("nnoremap <leader>p session.prev");
	type(",", "p");
	assert.equal(app.focusIdx, 0);

	ex("inoremap <C-s> edit.submit");
	type("i", ..."go", "\x13");
	assert.equal(app.mode, "NORMAL");
	assert.deepEqual(app.sessions[0].sent, ["go"]);

	ex("nmap <F2> :new ");
	type("\x1bOQ");
	assert.equal(app.mode, "COMMAND");
	assert.equal(app.cmdBuf, "new ");
	type("\x1b");

	ex("nmap J bad.action");
	assert.match(app.message, /E474: unknown action/);
	ex("nunmap Z");
	assert.match(app.message, /E31/);
	ex("nmap J");
	assert.equal(app.message, "No mapping found");
});

test("pasted text goes in as text, not as keys", () => {
	const { app, type } = makeApp({ insert: { jk: "<Esc>" } });
	type("i", "\x1b[200~ajk line\nnext\x1b[201~");
	assert.equal(app.mode, "INSERT");
	assert.equal(app.inputBuf, "ajk line next");
});

test(":help and :map open floating windows", () => {
	const { type, ex, overlays } = makeApp({ normal: { "<leader>t": "theme.picker" } });
	ex("help");
	assert.equal(overlays.length, 1);
	const text = overlays[0]
		.render(76)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(text, /NORMAL\s*│\s*│ \* <Space>t\s+pick a colorscheme/, "your mappings come first, marked");
	assert.match(text, /1-9\s+jump to session N/);
	ex("map");
	assert.equal(overlays.length, 2);
	type("q");
});
