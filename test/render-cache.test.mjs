import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "../dist/app.js";
import { DEFAULT_UI } from "../dist/config.js";
import { Keymap } from "../dist/keys.js";
import { Session } from "../dist/session.js";
import { BUILTIN_THEMES, Painter } from "../dist/theme.js";

class S extends Session {
	send(t) {
		this.pushUser(t);
	}
	abort() {}
}

function makeApp(session) {
	const tui = { requestRender() {}, showOverlay: () => ({ hide() {} }) };
	const app = new App(tui, { rows: 40, columns: 120, write() {} }, new Painter(BUILTIN_THEMES.default), { ...DEFAULT_UI }, new Keymap(), { config: { enabled: true } });
	app.addSession(session, true);
	return app;
}

const reply = (i) => `Reply ${i}:\n\n\`\`\`js\nconst x = ${i};\n\`\`\`\n\nand **done**.`;

function transcript() {
	const s = new S("cache", "m");
	s.engine = "claude";
	for (let i = 0; i < 5; i++) {
		s.pushUser(`prompt ${i}`);
		s.items.push({ kind: "tool", text: "", tool: { name: "Bash", summary: `npm test ${i}`, output: `ok ${i}\nall pass`, folded: true } });
		s.items.push({ kind: "agent", text: reply(i) });
	}
	s.version++;
	return s;
}

/** the pane's lines as a fresh app draws them: nothing cached */
const fresh = (s) => makeApp(s).buildPaneLines(100);

test("cached transcript lines are the lines a fresh render gives, after every kind of change", () => {
	const s = transcript();
	const app = makeApp(s);
	const lines = () => app.buildPaneLines(100);
	const same = (what) => assert.deepEqual(lines(), fresh(s), what);
	same("first render");

	// a reply streaming in
	s.items.push({ kind: "agent", text: "", streaming: true });
	for (const w of ["The ", "badge ", "now ", "counts."]) {
		s.items.at(-1).text += w;
		s.version++;
		same(`streamed '${w}'`);
	}
	s.items.at(-1).streaming = false;
	s.version++;
	same("streaming done");

	// unfolding an early tool call: the block ids after it move on by one
	s.items[1].tool.folded = false;
	s.version++;
	same("tool output unfolded");
	assert.ok(lines().some((l) => l.plain.includes("ok 0")));

	// a tool's output arriving in place, and a reply replaced by its final text
	s.items[4].tool.output = "ok 1\nall pass\nand more";
	s.items[4].tool.folded = false;
	s.items[2].text = reply(99);
	s.version++;
	same("changed in place");

	// items taken away at the front (a :tree jump, say): indices and blocks shift
	s.items.splice(0, 3);
	s.version++;
	same("items removed before");

	// another width, another theme
	assert.deepEqual(app.buildPaneLines(70), makeApp(s).buildPaneLines(70), "a narrower pane");
	app.setTheme(BUILTIN_THEMES["tokyonight-moon"]);
	const themed = makeApp(s);
	themed.setTheme(BUILTIN_THEMES["tokyonight-moon"]);
	assert.deepEqual(lines(), themed.buildPaneLines(100), "another theme");
});

test("a streamed delta redraws only the reply it's in, not the whole conversation", () => {
	const s = transcript();
	const app = makeApp(s);
	app.render(120);
	let drawn = 0;
	const renderItem = app.renderItem;
	app.renderItem = function (...a) {
		drawn++;
		return renderItem.apply(this, a);
	};
	s.items.push({ kind: "agent", text: "", streaming: true });
	s.version++;
	app.render(120);
	assert.equal(drawn, 1, "the new reply");
	s.items.at(-1).text += "more words";
	s.version++;
	app.render(120);
	assert.equal(drawn, 2, "only that reply again");
});
