#!/usr/bin/env node
/**
 * The optional Bun build: today's TypeScript (every engine) with Bun's runtime
 * inside (`bun build --compile`), riftri beside it. 85–110 MB, so it's never
 * released; the binary that ships is the Rust one (scripts/build-binary.mjs).
 * It's for running the TypeScript vigent where there's no Node, and for the
 * whole pty suite through a binary. Same layout as the Rust build:
 *
 *   dist-bin/vigent-<target>/vigent        (vigent.exe on Windows)
 *
 * and scripts/package-binaries.mjs takes it from there.
 *
 * usage:
 *   node scripts/build-binary-bun.mjs                 this machine's target
 *   node scripts/build-binary-bun.mjs linux-arm64     one target (Bun cross-compiles)
 *   node scripts/build-binary-bun.mjs --all           every target
 *
 * Needs Bun (https://bun.sh) and a built dist/ (`npm run build`).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exeName, packageAll, TARGETS } from "./package-binaries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(root, "dist-bin");

/** target → Bun's compile target, and the npm package with riftri's binary for it */
const BUILD = {
	"linux-x64": { bun: "bun-linux-x64", riftri: "riftri-linux-x64-gnu" },
	"linux-x64-baseline": { bun: "bun-linux-x64-baseline", riftri: "riftri-linux-x64-gnu" },
	"linux-arm64": { bun: "bun-linux-arm64", riftri: "riftri-linux-arm64-gnu" },
	"linux-x64-musl": { bun: "bun-linux-x64-musl", riftri: "riftri-linux-x64-musl" },
	"linux-arm64-musl": { bun: "bun-linux-arm64-musl", riftri: "riftri-linux-arm64-musl" },
	"darwin-arm64": { bun: "bun-darwin-arm64", riftri: "riftri-darwin-arm64" },
	"darwin-x64": { bun: "bun-darwin-x64", riftri: "riftri-darwin-x64" },
	"windows-x64": { bun: "bun-windows-x64", riftri: "riftri-win32-x64" },
};

/** The target for the machine this runs on. */
export function hostTarget(platform = process.platform, arch = process.arch, musl = isMusl()) {
	const system = platform === "win32" ? "windows" : platform;
	const name = `${system}-${arch}${platform === "linux" && musl ? "-musl" : ""}`;
	return TARGETS.includes(name) ? name : undefined;
}

function isMusl() {
	if (process.platform !== "linux") return false;
	return !process.report?.getReport()?.header?.glibcVersionRuntime;
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });

/** riftri's binary for a target, from its platform package at the version vigent depends on (npm checks the download). */
function riftriFor(pkg, exe) {
	const version = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "riftri", "package.json"), "utf8")).version;
	const installed = path.join(root, "node_modules", pkg, "bin", exe);
	if (fs.existsSync(installed) && JSON.parse(fs.readFileSync(path.join(root, "node_modules", pkg, "package.json"), "utf8")).version === version) return installed;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vigent-riftri-"));
	const tarball = run("npm", ["pack", `${pkg}@${version}`, "--silent"], { cwd: tmp, shell: process.platform === "win32" }).trim().split("\n").pop();
	run("tar", ["-xzf", tarball], { cwd: tmp });
	return path.join(tmp, "package", "bin", exe);
}

function build(target) {
	const t = BUILD[target];
	const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const dir = path.join(out, `vigent-${target}`);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	run("bun", [
		"build",
		path.join(root, "dist", "main.js"),
		"--compile",
		"--minify",
		`--target=${t.bun}`,
		// what version.ts would read from package.json, which the binary doesn't have
		"--define",
		`VIGENT_STANDALONE_VERSION=${JSON.stringify(version)}`,
		"--outfile",
		path.join(dir, exeName(target)),
	], { stdio: ["ignore", "ignore", "inherit"] });
	fs.copyFileSync(riftriFor(t.riftri, exeName(target, "riftri")), path.join(dir, exeName(target, "riftri")));
	if (!target.startsWith("windows")) fs.chmodSync(path.join(dir, "riftri"), 0o755);
}

function main(argv) {
	const targets = argv.includes("--all") ? [...TARGETS] : argv.filter((a) => !a.startsWith("-"));
	if (targets.length === 0) {
		const host = hostTarget();
		if (!host) throw new Error(`no target for ${process.platform}-${process.arch}; pick one: ${TARGETS.join(", ")}`);
		targets.push(host);
	}
	for (const t of targets) if (!BUILD[t]) throw new Error(`unknown target '${t}'; the targets: ${TARGETS.join(", ")}`);
	if (!fs.existsSync(path.join(root, "dist", "main.js"))) throw new Error("dist/ isn't built: run  npm run build  first");
	try {
		run("bun", ["--version"]);
	} catch {
		throw new Error("the Bun build needs Bun: https://bun.sh");
	}
	fs.mkdirSync(out, { recursive: true });
	for (const t of targets) build(t);
	packageAll(targets, out);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`build-binary-bun: ${err.message}`);
		process.exit(1);
	}
}
