/**
 * The Rust vigent (crates/vigent) embeds the built-in themes as text written
 * from src/builtin-themes.ts: it has to be regenerated when they change.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { themesText } from "../scripts/export-themes.mjs";
import { BUILTIN_THEMES } from "../dist/builtin-themes.js";

test("the Rust build's themes are the TypeScript ones (else: node scripts/export-themes.mjs)", () => {
	const file = path.join(import.meta.dirname, "..", "crates", "vigent", "src", "themes.txt");
	assert.equal(fs.readFileSync(file, "utf8"), themesText());
	for (const t of Object.values(BUILTIN_THEMES)) assert.match(fs.readFileSync(file, "utf8"), new RegExp(`^theme ${t.name} `, "m"));
});
