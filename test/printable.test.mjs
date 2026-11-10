import assert from "node:assert/strict";
import { test } from "node:test";
import { printable } from "../dist/printable.js";

test("printable: text with nothing to fix comes back as it was", () => {
	const s = "plain text, 中文, 🙂 and \x1b[31mcolor\x1b[0m\nsecond line";
	assert.equal(printable(s), s);
});

test("printable: tabs are two spaces and CRLF is a newline", () => {
	assert.equal(printable("\tmodified:\tsrc/app.ts\r\nnext"), "  modified:  src/app.ts\nnext");
});

test("printable: a carriage return keeps what came after it, like a progress bar ends up", () => {
	assert.equal(printable("10%\r50%\r100%\ndone"), "100%\ndone");
});

test("printable: colors and links stay; cursor moves, erases, titles and bells go", () => {
	const link = "\x1b]8;;https://example.com\x07site\x1b]8;;\x07";
	assert.equal(printable(`\x1b[1;32mok\x1b[0m ${link}`), `\x1b[1;32mok\x1b[0m ${link}`);
	assert.equal(printable("\x1b[2K\x1b[1Gcleared\x1b[3A\x1b[?25l"), "cleared");
	assert.equal(printable("\x1b]0;title\x07after\x07"), "after");
	assert.equal(printable("back\bspace\x00\x7f\x9b2J"), "backspace2J");
});
