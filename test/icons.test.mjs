import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI, loadConfig } from "../dist/config.js";
import { splitView } from "../dist/diffview.js";
import { fileIcon, NERD, toolIcon } from "../dist/icons.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-icons-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const plain = (lines) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function makeApp(icons) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 34, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI, icons }, new Keymap());
	app.defaultEngine = () => "claude";
	return app;
}

test('config: icons = "nerd" is accepted; anything else says what is', () => {
	const file = path.join(tmp, "config.toml");
	fs.writeFileSync(file, '[ui]\nicons = "nerd"\n');
	assert.equal(loadConfig(file).config.ui.icons, "nerd");
	fs.writeFileSync(file, '[ui]\nicons = "emoji"\n');
	assert.ok(loadConfig(file).warnings.some((w) => /should be "unicode", "nerd" or "ascii"/.test(w)));
});

test("file and tool icons, like nvim-web-devicons", () => {
	assert.deepEqual(fileIcon("src/app.ts"), ["", "Function"]);
	assert.equal(fileIcon("README.md")[0], "");
	assert.equal(fileIcon("package.json")[0], "", "by name before extension");
	assert.deepEqual(fileIcon("notes.unknownext"), [NERD.file, "Comment"]);
	assert.equal(toolIcon("Bash"), NERD.terminal);
	assert.equal(toolIcon("Edit"), NERD.pencil);
	assert.equal(toolIcon("Read"), NERD.fileText);
	assert.equal(toolIcon("Grep"), NERD.search);
	assert.equal(toolIcon("something_else"), NERD.wrench);
});

test("the dashboard, sidebar and tool rows use Nerd Font icons with icons = nerd", () => {
	const nerd = makeApp("nerd");
	let screen = plain(nerd.render(120));
	assert.ok(screen.includes(`${NERD.pencil} New agent`), "dashboard actions");
	assert.ok(screen.includes(`${NERD.palette} Theme`));
	assert.ok(screen.includes(NERD.bolt), "the footer");
	assert.match(screen, /██╗   ██╗██╗ ██████╗/, "the logo stays");

	const s = new (class extends Session {
		send() {}
		abort() {}
	})("fix it", "m");
	s.items.push({ kind: "tool", tool: { name: "Bash", summary: "npm test", folded: true } });
	nerd.addSession(s, true);
	screen = plain(nerd.render(120));
	assert.ok(screen.includes(`${NERD.caretRight} ${NERD.terminal} Bash npm test`), "tool row: fold caret, tool icon");

	const uni = plain(makeApp("unicode").render(120));
	assert.ok(uni.includes("✎ New agent") && !uni.includes(NERD.pencil), "unicode stays as it was");
});

test("the side-by-side diff puts a file icon before each file name", () => {
	const diff = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n";
	assert.deepEqual(splitView(diff, 80, true).lines[0], [["Function", " "], ["Title", "src/app.ts"]]);
	assert.deepEqual(splitView(diff, 80).lines[0], [["Title", "src/app.ts"]]);
});
