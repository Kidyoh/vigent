#!/usr/bin/env node
/**
 * Build the standalone vigent: the Rust port (crates/vigent, #168), one small
 * file with riftri linked in. For each target it writes
 *
 *   dist-bin/vigent-<target>/vigent        (vigent.exe on Windows)
 *
 * and packs it with scripts/package-binaries.mjs (unless --no-pack).
 *
 * usage:
 *   node scripts/build-binary.mjs                      this machine's target
 *   node scripts/build-binary.mjs linux-x64-musl ...   these (their Rust targets must be installed:
 *                                                      rustup target add <triple>)
 *   node scripts/build-binary.mjs --no-pack <targets>  build only (CI packs every runner's builds together)
 *
 * Needs Rust (https://rustup.rs). The Bun build of the TypeScript is
 * scripts/build-binary-bun.mjs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exeName, packageAll, TARGETS } from "./package-binaries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(root, "dist-bin");
const crate = path.join(root, "crates", "vigent");

/** target → Rust's target triple. x86-64 Rust doesn't need AVX2, so the baseline target is the same build. */
export const TRIPLES = {
	"linux-x64": "x86_64-unknown-linux-gnu",
	"linux-x64-baseline": "x86_64-unknown-linux-gnu",
	"linux-arm64": "aarch64-unknown-linux-gnu",
	"linux-x64-musl": "x86_64-unknown-linux-musl",
	"linux-arm64-musl": "aarch64-unknown-linux-musl",
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"windows-x64": "x86_64-pc-windows-msvc",
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

function build(target, built) {
	const triple = TRIPLES[target];
	if (!built.has(triple)) {
		execFileSync("cargo", ["build", "--release", "--locked", "--target", triple], { cwd: crate, stdio: ["ignore", "inherit", "inherit"] });
		built.add(triple);
	}
	const dir = path.join(out, `vigent-${target}`);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(path.join(crate, "target", triple, "release", exeName(target)), path.join(dir, exeName(target)));
	if (!target.startsWith("windows")) fs.chmodSync(path.join(dir, "vigent"), 0o755);
}

function main(argv) {
	const targets = argv.filter((a) => !a.startsWith("-"));
	if (targets.length === 0) {
		const host = hostTarget();
		if (!host) throw new Error(`no target for ${process.platform}-${process.arch}; pick one: ${TARGETS.join(", ")}`);
		targets.push(host);
	}
	for (const t of targets) if (!TRIPLES[t]) throw new Error(`unknown target '${t}'; the targets: ${TARGETS.join(", ")}`);
	try {
		execFileSync("cargo", ["--version"], { stdio: "ignore" });
	} catch {
		throw new Error("the Rust build needs Rust: https://rustup.rs (the Bun build: scripts/build-binary-bun.mjs)");
	}
	fs.mkdirSync(out, { recursive: true });
	const built = new Set();
	for (const t of targets) build(t, built);
	if (!argv.includes("--no-pack")) packageAll(targets, out);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`build-binary: ${err.message}`);
		process.exit(1);
	}
}
