import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessTerminal } from "../dist/tui.js";

test("ProcessTerminal: switches to alternate screen on start and restores main screen on stop", () => {
	let output = "";
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};

	try {
		const term = new ProcessTerminal();
		term.start(() => {}, () => {});
		assert.ok(output.includes("\x1b[?1049h"), "sent enter alternate screen sequence");

		const outputBeforeStop = output;
		term.stop();
		const stopOutput = output.slice(outputBeforeStop.length);
		assert.ok(stopOutput.includes("\x1b[?1049l"), "sent exit alternate screen sequence");
		assert.ok(stopOutput.includes("\x1b[?25h"), "ensured hardware cursor is visible");
	} finally {
		process.stdout.write = origWrite;
	}
});

test("ProcessTerminal: process exit event restores screen if exit occurs while running", () => {
	let output = "";
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		output += String(chunk);
		return true;
	};

	try {
		const term = new ProcessTerminal();
		term.start(() => {}, () => {});
		assert.ok(output.includes("\x1b[?1049h"), "entered alt screen");

		// simulate unexpected process termination
		process.emit("exit", 0);
		assert.ok(output.includes("\x1b[?1049l"), "exit event restored screen");
		assert.ok(output.includes("\x1b[?25h"), "exit event restored cursor");

		// subsequent stop() should not duplicate exit alternate screen sequences
		const outputBeforeStop = output;
		term.stop();
		const stopOutput = output.slice(outputBeforeStop.length);
		assert.ok(!stopOutput.includes("\x1b[?1049l"), "no duplicate exit alternate screen sequence");
	} finally {
		process.stdout.write = origWrite;
	}
});
