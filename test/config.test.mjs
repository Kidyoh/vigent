import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { applySetCommand, CONFIG_TEMPLATE, DEFAULT_UI, loadConfig } from "../dist/config.js";
import { buildKeymap } from "../dist/keys.js";

function withConfig(text, fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-cfg-"));
	const file = path.join(dir, "config.toml");
	fs.writeFileSync(file, text);
	try {
		return fn(file);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("loads theme, ui options and highlight overrides", () => {
	withConfig(
		'theme = "nord"\n[ui]\nsidebar_width = 40\nicons = "ascii"\nnumber = false\n[highlights]\nNormal = { bg = "NONE" }\nCursorLine = "guibg=#2a2f3a"\n',
		(file) => {
			const { config, warnings } = loadConfig(file);
			assert.deepEqual(warnings, []);
			assert.equal(config.theme, "nord");
			assert.deepEqual(config.ui, { ...DEFAULT_UI, sidebar_width: 40, icons: "ascii", number: false });
			assert.deepEqual(config.highlights, { Normal: { bg: "NONE" }, CursorLine: { bg: "#2a2f3a" } });
		},
	);
});

test("bad values become warnings, not crashes", () => {
	withConfig('theme = 3\nfoo = 1\n[ui]\nsidebar_width = 2\nwat = true\n', (file) => {
		const { config, warnings } = loadConfig(file);
		assert.equal(warnings.length, 4);
		assert.equal(config.ui.sidebar_width, DEFAULT_UI.sidebar_width);
	});
	withConfig("this is = not toml [", (file) => {
		assert.equal(loadConfig(file).warnings.length, 1);
	});
	assert.deepEqual(loadConfig("/nonexistent/config.toml").warnings, []);
});

test("the config template is valid and warning-free, keys included", () => {
	withConfig(CONFIG_TEMPLATE, (file) => {
		const { config, warnings } = loadConfig(file);
		assert.deepEqual(warnings, []);
		assert.equal(config.leader, "<Space>");
		const keys = buildKeymap(config.leader, config.keys);
		assert.deepEqual(keys.warnings, []);
		assert.ok(keys.keymap.lookup("normal", ["<Space>", "t"]).exact);
	});
});

test("keys sections: per mode, flat [keys] means normal, bad shapes warn", () => {
	withConfig(
		'leader = ","\ntimeoutlen = 1\n[ui]\ntimeoutlen = 300\n[keys]\nJ = "session.next"\n[keys.insert]\njk = "<Esc>"\n',
		(file) => {
			const { config, warnings } = loadConfig(file);
			assert.deepEqual(warnings, ["config: unknown key 'timeoutlen'"]);
			assert.equal(config.leader, ",");
			assert.equal(config.ui.timeoutlen, 300);
			assert.deepEqual(config.keys, { normal: { J: "session.next" }, insert: { jk: "<Esc>" } });
		},
	);
	withConfig('keys = "x"\n[ui]\ntimeoutlen = -5\n', (file) => {
		assert.equal(loadConfig(file).warnings.length, 2);
	});
});

test(":set handles vim's forms", () => {
	const ui = { ...DEFAULT_UI };
	applySetCommand(ui, "nonumber notilde");
	assert.equal(ui.number, false);
	assert.equal(ui.tilde, false);
	applySetCommand(ui, "number! invtilde");
	assert.equal(ui.number, true);
	assert.equal(ui.tilde, true);
	applySetCommand(ui, "sbw=42 icons=ascii");
	assert.equal(ui.sidebar_width, 42);
	assert.equal(ui.icons, "ascii");
	assert.match(applySetCommand(ui, "sidebar_width?").message, /sidebar_width=42/);
	assert.ok(applySetCommand(ui, "bogus").error);
	assert.ok(applySetCommand(ui, "sidebar_width=5").error);
	assert.match(applySetCommand(ui, "").message, /icons=ascii/);
	applySetCommand(ui, "tm=250");
	assert.equal(ui.timeoutlen, 250);
});
