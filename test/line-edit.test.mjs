import assert from "node:assert/strict";
import { test } from "node:test";
import { completeCommandLine, EX_COMMANDS } from "../dist/completion.js";
import { LineEditor } from "../dist/line-edit.js";

/** "foo |bar": the text, with the cursor before the character after the bar. */
function at(marked) {
	const e = new LineEditor();
	const pos = marked.indexOf("|");
	e.sync(marked.replace("|", ""), pos);
	return e;
}
const shown = (e) => {
	const c = [...e.chars];
	c.splice(e.pos, 0, "|");
	return c.join("");
};
function run(marked, keys) {
	const e = at(marked);
	let last = {};
	for (const k of keys) last = e.feed(k);
	return { e, last, line: shown(e) };
}
const K = (s) => [...s].map((c) => (c === " " ? "<Space>" : c === "<" ? "<lt>" : c));

const CASES = [
	// motions
	["|foo bar.baz", "w", "foo |bar.baz"],
	["|foo bar.baz", "2w", "foo bar|.baz"],
	["|foo bar.baz", "W", "foo |bar.baz"],
	["foo |bar.baz qux", "W", "foo bar.baz |qux"],
	["|foo bar", "e", "fo|o bar"],
	["fo|o bar", "e", "foo ba|r"],
	["foo ba|r", "b", "foo |bar"],
	["foo |bar", "b", "|foo bar"],
	["foo bar.|baz", "B", "foo |bar.baz"],
	["foo |bar", "ge", "fo|o bar"],
	["fo|o", "0", "|foo"],
	["  fo|o", "^", "  |foo"],
	["|foo", "$", "fo|o"],
	["|hello", "3l", "hel|lo"],
	["hel|lo", "2h", "h|ello"],
	["|hello", "3|", "he|llo"],
	["|a,b,c", "f,", "a|,b,c"],
	["|a,b,c", "2f,", "a,b|,c"],
	["|a,b,c", "t,", "|a,b,c"],
	["a,b,|c", "F,", "a,b|,c"],
	["a,b,|c", "T,", "a,b,|c"],
	["|a,b,c", "f,;", "a,b|,c"],
	["|a,b,c", "f,;,", "a|,b,c"],
	["|abc", "fz", "|abc"],
	// delete
	["|foo bar", "x", "|oo bar"],
	["|foo bar", "2x", "|o bar"],
	["fo|o", "X", "f|o"],
	["|foo bar baz", "dw", "|bar baz"],
	["|foo bar baz", "d2w", "|baz"],
	["|foo bar baz", "2dw", "|baz"],
	["|foo bar", "de", "| bar"],
	["foo |bar", "db", "|bar"],
	["foo |bar", "d$", "foo| "],
	["foo |bar", "D", "foo| "],
	["foo |bar", "d0", "|bar"],
	["|a,b,c", "dt,", "|,b,c"],
	["|a,b,c", "df,", "|b,c"],
	["a,b,|c", "dF,", "a,b|c"],
	["foo bar", "dd", "|"],
	["foo b|ar baz", "diw", "foo | baz"],
	["foo b|ar baz", "daw", "foo |baz"],
	["foo b|az", "daw", "fo|o"],
	['say "he|llo" now', 'di"', 'say "|" now'],
	['say "he|llo" now', 'da"', "say |now"],
	["call(a, |b)", "di(", "call(|)"],
	["call(a, |b)", "da(", "cal|l"],
	["f(g(|x))", "dib", "f(g(|))"],
	["x [1, |2] y", "di]", "x [|] y"],
	["x {1, |2} y", "diB", "x {|} y"],
	["<a|b>", "di<", "<|>"],
	["no pair |here", "di(", "no pair |here"],
	// the rest
	["|cat", "rb", "|bat"],
	["|cat", "2rx", "x|xt"],
	["|cat", "~", "C|at"],
	["|cat", "3~", "CA|T"],
	["|foo bar", "dwP", "foo| bar"],
	["|foo bar", "xp", "o|fo bar"],
	["|foo bar", "dwu", "|foo bar"],
	["|foo bar", "x.", "|o bar"],
	["|a b c d", "dw.", "|c d"],
	["|foo", "xxuu", "|foo"],
];

for (const [start, keys, want] of CASES) {
	test(`${start}  ${keys}`, () => {
		assert.equal(run(start, K(keys)).line, want);
	});
}

test("<C-r> redoes what u undid", () => {
	assert.equal(run("|foo bar", [...K("dwu"), "<C-r>"]).line, "|bar");
});

test("change commands leave for INSERT at the right place", () => {
	for (const [start, keys, want] of [
		["|foo bar", "cw", "| bar"],
		["|foo bar", "c2w", "|"],
		["foo b|ar", "ciw", "foo |"],
		["|foo bar", "s", "|oo bar"],
		["|foo", "S", "|"],
		["foo |bar", "C", "foo |"],
		["foo b|ar", "cc", "|"],
	]) {
		const r = run(start, K(keys));
		assert.equal(r.last.exit, "insert", `${start} ${keys}`);
		assert.equal(r.line, want, `${start} ${keys}`);
	}
});

test("i a I A go back to typing; Enter sends; Esc leaves unless a command is pending", () => {
	assert.equal(run("fo|o", ["i"]).line, "fo|o");
	assert.equal(run("fo|o", ["a"]).line, "foo|");
	assert.equal(run("  fo|o", ["I"]).line, "  |foo");
	assert.equal(run("|foo", ["A"]).line, "foo|");
	for (const k of ["i", "a", "I", "A"]) assert.equal(run("foo|", [k]).last.exit, "insert");
	assert.equal(run("|foo", ["<CR>"]).last.exit, "submit");
	assert.equal(run("|foo", ["<Esc>"]).last.exit, "back");
	assert.equal(run("|foo", ["d", "<Esc>"]).last.exit, undefined, "Esc cancels the d");
	assert.equal(run("|foo", ["d", "<Esc>"]).line, "|foo");
	assert.equal(run("|foo", ["3", "<Esc>", "x"]).line, "|oo", "and forgets a count");
});

test("yanking copies and doesn't move text; j and k ask for history; a register name is accepted", () => {
	const r = run("|foo bar", K("yw"));
	assert.equal(r.last.yanked, "foo ");
	assert.equal(r.e.text, "foo bar");
	assert.equal(run("|foo bar", K("Y")).last.yanked, "foo bar");
	assert.equal(run("|foo", ["k"]).last.history, -1);
	assert.equal(run("|foo", ["j"]).last.history, 1);
	assert.equal(run("|foo bar", K('"ayw')).last.yanked, "foo ");
});

test("the character classes follow unicode, and an empty line is safe for every key", () => {
	assert.equal(run("|héllo wörld", K("w")).line, "héllo |wörld");
	assert.equal(run("|日本語 テ", K("w")).line, "日本語 |テ");
	for (const k of "hlwbeWBE0^$xXDYp~uJ.".split("")) assert.equal(run("|", [k]).line, "|", k);
	assert.equal(run("|", K("dw")).line, "|");
	assert.equal(run("|", K("diw")).line, "|");
	assert.equal(run("|", K("rx")).line, "|");
});

test("typing done in INSERT comes back as one undo step", () => {
	const e = at("|foo");
	e.sync("foo bar", 6);
	e.feed("u");
	assert.equal(e.text, "foo");
});

test("completion: command names, agents anywhere in the name, themes from the start", () => {
	const sources = { agents: ["fix flaky test", "add retries"], themes: ["tokyonight", "tender"] };
	assert.deepEqual(completeCommandLine("vs", sources), { base: "", items: ["vsplit"] });
	assert.deepEqual(completeCommandLine("b fla", sources), { base: "b ", items: ["fix flaky test"] });
	assert.deepEqual(completeCommandLine("colo tok", sources), { base: "colo ", items: ["tokyonight"] });
	assert.deepEqual(completeCommandLine("merge x", sources).items, []);
});

test("every command offered is one vigent runs", async () => {
	const fs = await import("node:fs");
	const app = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
	for (const name of EX_COMMANDS) assert.ok(app.includes(`case "${name}":`), `:${name} has no case in exec`);
});

test("c and what's typed after it are one undo step", () => {
	const e = at("foo b|ar baz");
	assert.equal(e.feed("c").exit, undefined);
	e.feed("i");
	assert.equal(e.feed("w").exit, "insert");
	e.sync("foo qux baz", 7);
	e.feed("u");
	assert.equal(e.text, "foo bar baz");
});
