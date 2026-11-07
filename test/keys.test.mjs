import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	buildKeymap,
	KeySequencer,
	Keymap,
	keyFromInput,
	parseKeys,
	parseRhs,
	replayKeys,
	tokenText,
} from "../dist/keys.js";

test("vim key notation", () => {
	assert.deepEqual(parseKeys("<C-d>"), ["<C-d>"]);
	assert.deepEqual(parseKeys("<c-D>"), ["<C-d>"]);
	assert.deepEqual(parseKeys("gg"), ["g", "g"]);
	assert.deepEqual(parseKeys("<leader>t", "<Space>"), ["<Space>", "t"]);
	assert.deepEqual(parseKeys("<Leader>t", ","), [",", "t"]);
	assert.deepEqual(parseKeys("<leader>t"), ["\\", "t"], "vim's default leader is backslash");
	assert.deepEqual(parseKeys("<S-a>"), ["A"]);
	assert.deepEqual(parseKeys("<S-Tab>"), ["<S-Tab>"]);
	assert.deepEqual(parseKeys("<A-x><M-x>"), ["<M-x>", "<M-x>"]);
	assert.deepEqual(parseKeys("<Enter><Return><CR>"), ["<CR>", "<CR>", "<CR>"]);
	assert.deepEqual(parseKeys("<C-^>"), ["<C-^>"]);
	assert.deepEqual(parseKeys("<lt>"), ["<lt>"]);
	assert.deepEqual(parseKeys("<"), ["<lt>"]);
	assert.deepEqual(parseKeys("<foo>"), ["<lt>", "f", "o", "o", ">"], "unknown <...> is literal, like vim");
	assert.deepEqual(parseKeys("a b"), ["a", "<Space>", "b"]);
	assert.deepEqual(parseKeys("<F5><PageDown><C-S-p>"), ["<F5>", "<PageDown>", "<C-S-p>"]);
	assert.throws(() => parseKeys(""));
});

test("typed keys match the notation you write", () => {
	const cases = {
		"\x04": "<C-d>",
		j: "j",
		G: "G",
		"\x1b[106;2u": "J", // kitty protocol shift+j
		"\r": "<CR>",
		"\x1b": "<Esc>",
		" ": "<Space>",
		"\t": "<Tab>",
		"\x1b[Z": "<S-Tab>",
		"\x1e": "<C-^>",
		"\x1bx": "<M-x>",
		"\x7f": "<BS>",
		"\x1b[A": "<Up>",
		"<": "<lt>",
		é: "é",
		":": ":",
	};
	for (const [raw, notation] of Object.entries(cases)) {
		assert.equal(keyFromInput(raw), notation, JSON.stringify(raw));
		assert.deepEqual(parseKeys(notation), [notation]);
	}
	assert.equal(tokenText("<Space>"), " ");
	assert.equal(tokenText("<lt>"), "<");
	assert.equal(tokenText("<C-d>"), undefined);
});

test("right-hand sides", () => {
	assert.deepEqual(parseRhs("session.next"), [{ kind: "action", name: "session.next", arg: undefined }]);
	assert.deepEqual(parseRhs("session.goto 3"), [{ kind: "action", name: "session.goto", arg: "3" }]);
	assert.throws(() => parseRhs("session.nxt"), /unknown action 'session.nxt' \(did you mean 'session.next'\?\)/);
	assert.throws(() => parseRhs("zzz.qqq"), (err) => !/did you mean/.test(err.message));
	assert.deepEqual(parseRhs(":colorscheme nord<CR>"), [{ kind: "ex", cmd: "colorscheme nord", execute: true }]);
	assert.deepEqual(parseRhs(":new "), [{ kind: "ex", cmd: "new ", execute: false }], "keeps the trailing space");
	assert.deepEqual(parseRhs("<Cmd>kill<CR>"), [{ kind: "ex", cmd: "kill", execute: true }]);
	assert.deepEqual(parseRhs("gg"), [{ kind: "keys", keys: ["g", "g"] }]);
	assert.deepEqual(parseRhs("<Esc>"), [{ kind: "keys", keys: ["<Esc>"] }]);
	assert.deepEqual(parseRhs(false), [{ kind: "nop" }]);
	assert.deepEqual(parseRhs("<Nop>"), [{ kind: "nop" }]);
	assert.deepEqual(parseRhs(["fold.open_all", "G"]), [
		{ kind: "action", name: "fold.open_all", arg: undefined },
		{ kind: "keys", keys: ["G"] },
	]);
	assert.throws(() => parseRhs(42));
});

test("keymap: defaults, user overrides, unmapping, prefixes", () => {
	const km = new Keymap("<Space>");
	assert.equal(km.lookup("normal", ["j"]).exact.rhsText, "scroll.down");
	assert.equal(km.lookup("normal", ["g"]).prefix, true);
	assert.equal(km.lookup("normal", ["g"]).exact, undefined);

	km.set("normal", "j", "session.next");
	assert.equal(km.lookup("normal", ["j"]).exact.rhsText, "session.next");
	assert.equal(km.lookup("normal", ["j"], true).exact.rhsText, "scroll.down", "built-in map is untouched");

	km.set("normal", "<leader>t", "theme.picker");
	assert.equal(km.lookup("normal", ["<Space>"]).prefix, true);
	assert.ok(km.lookup("normal", ["<Space>", "t"]).exact.user);

	assert.equal(km.unset("normal", "q"), true);
	assert.equal(km.lookup("normal", ["q"]).exact, undefined);
	assert.equal(km.unset("normal", "q"), false);
	assert.throws(() => km.set("insert", "jk", "nope.nope"), /unknown action/);
});

test("buildKeymap reports bad entries as warnings and keeps the good ones", () => {
	const { keymap, warnings } = buildKeymap("<Space>", {
		normal: { "<leader>t": "theme.picker", x: "bad.action", "": "noop" },
		insert: { jk: "<Esc>" },
	});
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /\[keys.normal\] "x": unknown action 'bad.action'/);
	assert.ok(keymap.lookup("normal", ["<Space>", "t"]).exact);
	assert.ok(keymap.lookup("insert", ["j", "k"]).exact);
});

function harness(keymap, startMode = "normal", timeoutlen = 25) {
	const log = [];
	const state = { mode: startMode };
	const host = {
		mode: () => state.mode,
		timeoutlen: () => timeoutlen,
		changed: () => {},
		run: (binding, keys) => {
			if (!binding) {
				log.push(`type:${keys.join("")}`);
				return;
			}
			for (const r of binding.rhs) {
				if (r.kind === "action") {
					log.push(r.name);
					if (r.name === "mode.insert") state.mode = "insert";
					if (r.name === "mode.normal") state.mode = "normal";
				} else if (r.kind === "keys") {
					replayKeys(keymap, host, r.keys);
				} else log.push(r.kind);
			}
		},
	};
	return { seq: new KeySequencer(keymap, host), log, state };
}

test("sequencer: jk in insert mode, with vim's timeout", async () => {
	const km = new Keymap();
	km.set("insert", "jk", "<Esc>");

	let h = harness(km, "insert");
	h.seq.feed("j");
	assert.deepEqual(h.log, [], "j waits for a possible k");
	h.seq.feed("k");
	assert.deepEqual(h.log, ["mode.normal"]);

	h = harness(km, "insert");
	h.seq.feed("j");
	h.seq.feed("x");
	assert.deepEqual(h.log, ["type:j", "type:x"], "j then x types both");

	h = harness(km, "insert");
	h.seq.feed("j");
	await sleep(60);
	assert.deepEqual(h.log, ["type:j"], "after timeoutlen the j is typed");
});

test("sequencer: a shorter mapping fires on timeout or when the next key breaks the sequence", async () => {
	const km = new Keymap();
	km.set("normal", "g", "session.next");
	let h = harness(km);
	h.seq.feed("g");
	h.seq.feed("g");
	assert.deepEqual(h.log, ["scroll.top"], "gg still works");

	h = harness(km);
	h.seq.feed("g");
	h.seq.feed("j");
	assert.deepEqual(h.log, ["session.next", "scroll.down"]);

	h = harness(km);
	h.seq.feed("g");
	await sleep(60);
	assert.deepEqual(h.log, ["session.next"]);

	h = harness(new Keymap());
	h.seq.feed("g");
	h.seq.feed("x");
	assert.deepEqual(h.log, ["type:g", "type:x"], "unmapped keys fall through");
});

test("key right-hand sides replay the built-in meaning (no recursion)", () => {
	const km = new Keymap();
	km.set("normal", "j", "k"); // swap j and k
	km.set("normal", "k", "j");
	const h = harness(km);
	h.seq.feed("j");
	h.seq.feed("k");
	assert.deepEqual(h.log, ["scroll.up", "scroll.down"]);

	km.set("normal", "<F2>", "ihello");
	const h2 = harness(km);
	h2.seq.feed("<F2>");
	assert.deepEqual(h2.log, ["mode.insert", "type:h", "type:e", "type:l", "type:l", "type:o"]);
});

test("docs/config.md documents every action and built-in key", async () => {
	const fs = await import("node:fs");
	const { ACTIONS, DEFAULT_KEYS } = await import("../dist/keys.js");
	const doc = fs.readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
	for (const name of Object.keys(ACTIONS)) assert.ok(doc.includes(`\`${name}`), `docs/config.md is missing action ${name}`);
	for (const [mode, keys] of Object.entries(DEFAULT_KEYS)) {
		for (const lhs of Object.keys(keys)) {
			if (/^\d$/.test(lhs)) continue; // documented as 1 … 9
			assert.ok(doc.includes(`\`${lhs}\``), `docs/config.md is missing ${mode} key ${lhs}`);
		}
	}
});

test("the example in docs/config.md is valid", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { loadConfig } = await import("../dist/config.js");
	const doc = fs.readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");
	const example = /## A complete example\s+```toml\n([\s\S]*?)```/.exec(doc)[1];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-doc-"));
	try {
		const file = path.join(dir, "config.toml");
		fs.writeFileSync(file, example);
		const { config, warnings } = loadConfig(file);
		assert.deepEqual(warnings, []);
		const keys = buildKeymap(config.leader, config.keys);
		assert.deepEqual(keys.warnings, []);
		assert.equal(keys.keymap.bindings("normal").filter((b) => b.user).length, 12);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
