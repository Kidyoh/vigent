import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { detectPi } from "../dist/engines.js";
import { loadPiSdk, PI_INSTALL, piInstalled } from "../dist/pi-sdk.js";

const root = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("the pi engine is optional: the light install leaves it out, and vigent says how to add it back", async () => {
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@mariozechner/pi-tui", "smol-toml"], "only what every engine needs");
	for (const p of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-ai", "riftri"]) assert.ok(pkg.optionalDependencies[p], p);

	assert.equal(piInstalled(), true, "a normal install has it");
	assert.equal(piInstalled(() => {
		throw Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" });
	}), false);
	assert.ok(await loadPiSdk());

	const missing = detectPi({ ANTHROPIC_API_KEY: "x" }, false);
	assert.deepEqual(missing, { id: "pi", name: "pi", installed: false, connected: false, detail: "not installed (light install)", install: PI_INSTALL });
	assert.equal(detectPi({ ANTHROPIC_API_KEY: "x" }, true).connected, true);
});

test("startup loads no more of pi-tui than vigent draws, and none of the pi engine", () => {
	// every pi-tui import goes through src/tui.ts, which skips its editor, markdown and image modules
	for (const f of fs.readdirSync(path.join(root, "src"))) {
		if (f === "tui.ts" || !f.endsWith(".ts")) continue;
		assert.doesNotMatch(fs.readFileSync(path.join(root, "src", f), "utf8"), /from "@mariozechner\/pi-tui"/, f);
	}
	// what `vigent --version` loads: no marked (pi-tui's markdown), no pi SDK, no provider SDKs
	const r = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const seen = []; const m = await import("node:module"); if (!m.registerHooks) { console.error("[]"); process.exit(0); } m.registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } }); process.on("exit", () => console.error(JSON.stringify(seen))); process.argv = [process.execPath, "vigent", "--version"]; await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "cli.js")).href)});`,
		],
		{ encoding: "utf8" },
	);
	assert.match(r.stdout, /^vigent \d/);
	const seen = JSON.parse(r.stderr.trim().split("\n").pop());
	if (seen.length === 0) return; // this Node has no module hooks to look with
	assert.ok(seen.some((u) => u.includes("pi-tui/dist/tui.js")), "pi-tui is loaded");
	for (const heavy of ["/marked/", "pi-coding-agent", "pi-ai", "/openai/", "@anthropic-ai", "pi-tui/dist/components/editor.js"]) {
		assert.ok(!seen.some((u) => u.includes(heavy)), `${heavy} isn't loaded at startup`);
	}
});

test("the vigent command turns on Node's compile cache before loading anything else", () => {
	assert.equal(pkg.bin.vigent, "./dist/main.js");
	const main = fs.readFileSync(path.join(root, "dist", "main.js"), "utf8");
	assert.match(main, /^#!\/usr\/bin\/env node/);
	assert.ok(main.indexOf("enableCompileCache") < main.indexOf('import("./cli.js")'));
	assert.equal(execFileSync(process.execPath, [path.join(root, "dist", "main.js"), "--version"], { encoding: "utf8" }).trim().split(" ")[0], "vigent");
});
