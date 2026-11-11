import assert from "node:assert/strict";
import { test } from "node:test";
import { LineSplitter } from "../dist/lines.js";

test("lines come out whole however the chunks fall", () => {
	const text = 'one\n{"a":1}\n\nlast line without a newline';
	for (let size = 1; size <= text.length; size++) {
		const s = new LineSplitter();
		const got = [];
		for (let i = 0; i < text.length; i += size) got.push(...s.push(text.slice(i, i + size)));
		assert.deepEqual(got, ["one", '{"a":1}', ""], `chunks of ${size}`);
		assert.equal(s.rest(), "last line without a newline");
		assert.equal(s.rest(), "", "rest forgets what it gave");
	}
	const s = new LineSplitter();
	assert.deepEqual(s.push("a\nb\n"), ["a", "b"]);
	assert.equal(s.rest(), "");
});

test("a line of many megabytes in small chunks doesn't take quadratic time", () => {
	// a tool's whole output as one JSON event, the way a pipe hands it over (16 KB at a time on macOS)
	const line = `${JSON.stringify({ type: "tool_result", output: "x".repeat(20 * 1024 * 1024) })}\n`;
	const s = new LineSplitter();
	const t = performance.now();
	const got = [];
	for (let i = 0; i < line.length; i += 16384) got.push(...s.push(line.slice(i, i + 16384)));
	const ms = performance.now() - t;
	assert.equal(got.length, 1);
	assert.equal(got[0].length, line.length - 1);
	assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms (growing one string and searching it each time took seconds)`);
});
