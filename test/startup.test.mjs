import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { detectPi } from "../dist/engines.js";
import { PI_INSTALL } from "../dist/pi-cli.js";
import { PiSession } from "../dist/pi-session.js";

const root = path.join(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("vigent bundles no agent: pi is your own install, like Claude Code or Codex", async () => {
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["get-east-asian-width", "riftri", "smol-toml"], "text width, worktrees, config: nothing else");
	assert.equal(pkg.optionalDependencies, undefined);
	assert.ok(!pkg.dependencies["@mariozechner/pi-coding-agent"] && !pkg.optionalDependencies?.["@mariozechner/pi-coding-agent"], "the pi agent isn't shipped");

	const missing = detectPi({ ANTHROPIC_API_KEY: "x", PATH: "" });
	assert.deepEqual(missing, { id: "pi", name: "pi", installed: false, connected: false, detail: "not installed", install: PI_INSTALL });
	assert.equal(PI_INSTALL, "npm install -g @mariozechner/pi-coding-agent");
	assert.equal(detectPi({ ANTHROPIC_API_KEY: "x" }, true).connected, true);
	assert.equal(detectPi({ HOME: "/nowhere", PI_CODING_AGENT_DIR: "/nowhere" }, true).connected, false, "no key, no login, no providers");

	// starting a pi agent without pi says how to get it
	const s = new PiSession("x", "default", { cwd: root, bin: "pi-not-here-anywhere" });
	await assert.rejects(s.ready, /pi isn't installed: npm install -g @mariozechner\/pi-coding-agent/);
	assert.ok(s.items.some((i) => /pi isn't installed/.test(i.text)));
});

test("pi-tui is vendored (only what vigent draws) and nothing loads an agent at startup", () => {
	// every pi-tui import goes through src/tui.ts, to the vendored copy (no koffi, no editor or markdown)
	for (const f of fs.readdirSync(path.join(root, "src"))) {
		if (!f.endsWith(".ts")) continue;
		assert.doesNotMatch(fs.readFileSync(path.join(root, "src", f), "utf8"), /from "@mariozechner\//, f);
	}
	assert.ok(fs.existsSync(path.join(root, "dist", "vendor", "pi-tui", "tui.js")), "the build copies it");
	assert.match(fs.readFileSync(path.join(root, "src", "vendor", "pi-tui", "LICENSE"), "utf8"), /MIT License/);
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
	assert.ok(seen.some((u) => u.includes("vendor/pi-tui/tui.js")), "pi-tui is loaded");
	for (const heavy of ["/marked/", "pi-coding-agent", "pi-ai", "/openai/", "@anthropic-ai", "@mariozechner/", "koffi"]) {
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
