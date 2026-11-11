#!/usr/bin/env node
/**
 * Build the standalone vigent: one executable with its runtime inside (Bun's
 * `bun build --compile`), for machines without Node. Each target becomes
 *
 *   dist-bin/vigent-<target>/vigent        the executable
 *   dist-bin/vigent-<target>/riftri        riftri for that platform, for copy-on-write worktrees
 *   dist-bin/vigent-<target>.tar.gz        both, with the README and LICENSE
 *   dist-bin/SHA256SUMS                    of every archive built so far
 *
 * and, for machines that have Node 20 or newer, the small build: vigent as one
 * JavaScript file their Node runs, a few MB with riftri (macOS and Linux)
 *
 *   dist-bin/vigent-<target>-node/vigent.mjs
 *   dist-bin/vigent-<target>-node/riftri
 *   dist-bin/vigent-<target>-node.tar.gz
 *
 * usage:
 *   node scripts/build-binary.mjs                 this machine's target
 *   node scripts/build-binary.mjs linux-arm64     one target (Bun cross-compiles)
 *   node scripts/build-binary.mjs --all           every target
 *   node scripts/build-binary.mjs --no-node       skip the small builds
 *   node scripts/build-binary.mjs --list          the target names
 *
 * Needs Bun (https://bun.sh) and a built dist/ (`npm run build`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(root, "dist-bin");

/** target → Bun's compile target, and the npm package with riftri's binary for it */
export const TARGETS = {
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
	return TARGETS[name] ? name : undefined;
}

function isMusl() {
	if (process.platform !== "linux") return false;
	return !process.report?.getReport()?.header?.glibcVersionRuntime;
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

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

/** The targets with a small build: the JavaScript is the same everywhere, riftri isn't. No Windows (it would need a .cmd launcher) and no baseline (that's about the binary's runtime). */
export function hasNodeBuild(target) {
	return !target.startsWith("windows") && !target.endsWith("-baseline");
}

/** vigent as one JavaScript file (cached: every target gets the same one). */
let bundled;
function nodeBundle(version) {
	if (bundled) return bundled;
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-bundle-")), "vigent.mjs");
	run("bun", [
		"build",
		path.join(root, "dist", "main.js"),
		"--target=node",
		"--format=esm",
		"--minify",
		"--define",
		`VIGENT_STANDALONE_VERSION=${JSON.stringify(version)}`,
		"--define",
		'VIGENT_STANDALONE_KIND="node"',
		"--outfile",
		file,
	], { stdio: ["ignore", "ignore", "inherit"] });
	const text = fs.readFileSync(file, "utf8");
	if (!text.startsWith("#!")) fs.writeFileSync(file, `#!/usr/bin/env node\n${text}`);
	fs.chmodSync(file, 0o755);
	return (bundled = file);
}

function buildNode(target) {
	const t = TARGETS[target];
	const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const name = `vigent-${target}-node`;
	const dir = path.join(out, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(nodeBundle(version), path.join(dir, "vigent.mjs"));
	fs.chmodSync(path.join(dir, "vigent.mjs"), 0o755);
	fs.copyFileSync(riftriFor(t.riftri, "riftri"), path.join(dir, "riftri"));
	fs.chmodSync(path.join(dir, "riftri"), 0o755);
	for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
	const archive = path.join(out, `${name}.tar.gz`);
	fs.rmSync(archive, { force: true });
	run("tar", ["-czf", archive, "-C", out, name]);
	console.log(`${`${target} (node)`.padEnd(20)} vigent ${mb(fs.statSync(path.join(dir, "vigent.mjs")).size).padStart(9)}   archive ${mb(fs.statSync(archive).size).padStart(8)}`);
}

function build(target) {
	const t = TARGETS[target];
	const windows = target.startsWith("windows");
	const exe = (name) => (windows ? `${name}.exe` : name);
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
		path.join(dir, exe("vigent")),
	], { stdio: ["ignore", "ignore", "inherit"] });

	fs.copyFileSync(riftriFor(t.riftri, exe("riftri")), path.join(dir, exe("riftri")));
	if (!windows) fs.chmodSync(path.join(dir, "riftri"), 0o755);
	for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));

	const archive = path.join(out, `vigent-${target}.tar.gz`);
	fs.rmSync(archive, { force: true });
	run("tar", ["-czf", archive, "-C", out, `vigent-${target}`]);
	console.log(`${target.padEnd(20)} vigent ${mb(fs.statSync(path.join(dir, exe("vigent"))).size).padStart(9)}   archive ${mb(fs.statSync(archive).size).padStart(8)}`);
}

function writeSums() {
	const archives = fs.readdirSync(out).filter((f) => f.endsWith(".tar.gz")).sort();
	fs.writeFileSync(path.join(out, "SHA256SUMS"), archives.map((f) => `${sha256(path.join(out, f))}  ${f}\n`).join(""));
}

function main(argv) {
	if (argv.includes("--list")) return console.log(Object.keys(TARGETS).join("\n"));
	if (argv.includes("--sums")) return writeSums();
	const targets = argv.includes("--all") ? Object.keys(TARGETS) : argv.filter((a) => !a.startsWith("-"));
	if (targets.length === 0) {
		const host = hostTarget();
		if (!host) throw new Error(`no target for ${process.platform}-${process.arch}; pick one: ${Object.keys(TARGETS).join(", ")}`);
		targets.push(host);
	}
	for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target '${t}'; the targets: ${Object.keys(TARGETS).join(", ")}`);
	if (!fs.existsSync(path.join(root, "dist", "main.js"))) throw new Error("dist/ isn't built: run  npm run build  first");
	try {
		run("bun", ["--version"]);
	} catch {
		throw new Error("building the binary needs Bun: https://bun.sh");
	}
	fs.mkdirSync(out, { recursive: true });
	for (const t of targets) {
		build(t);
		if (!argv.includes("--no-node") && hasNodeBuild(t)) buildNode(t);
	}
	writeSums();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`build-binary: ${err.message}`);
		process.exit(1);
	}
}
