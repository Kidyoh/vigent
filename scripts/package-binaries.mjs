#!/usr/bin/env node
/**
 * Pack built vigent binaries for a release. It doesn't care what built them
 * (a Rust build drops its output in the same place):
 *
 *   dist-bin/vigent-<target>/vigent        the executable (vigent.exe on Windows)
 *   dist-bin/vigent-<target>/…             anything else that ships beside it
 *
 * becomes
 *
 *   dist-bin/vigent-<target>.tar.gz        that folder, with the README and LICENSE
 *   dist-bin/SHA256SUMS                    one line per archive
 *
 * which is what install.sh, install.ps1, the Homebrew formula, the container
 * image and the Binaries workflow read.
 *
 *   node scripts/package-binaries.mjs              every target that's built
 *   node scripts/package-binaries.mjs linux-x64    only these
 *   node scripts/package-binaries.mjs --list       the target names
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The platforms vigent ships for. install.sh and install.ps1 pick among these names. */
export const TARGETS = ["linux-x64", "linux-x64-baseline", "linux-arm64", "linux-x64-musl", "linux-arm64-musl", "darwin-arm64", "darwin-x64", "windows-x64"];

/** The executable's name in a target's folder. */
export const exeName = (target, name = "vigent") => (target.startsWith("windows") ? `${name}.exe` : name);

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Pack one target's folder; returns the sizes. Throws when its executable isn't there. */
export function packageTarget(target, out = path.join(root, "dist-bin")) {
	if (!TARGETS.includes(target)) throw new Error(`unknown target '${target}'; the targets: ${TARGETS.join(", ")}`);
	const dir = path.join(out, `vigent-${target}`);
	const exe = path.join(dir, exeName(target));
	if (!fs.existsSync(exe)) throw new Error(`${path.relative(root, exe)} isn't built`);
	for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(dir, f));
	const archive = path.join(out, `vigent-${target}.tar.gz`);
	fs.rmSync(archive, { force: true });
	execFileSync("tar", ["-czf", archive, "-C", out, `vigent-${target}`], { stdio: ["ignore", "ignore", "inherit"] });
	return { target, binary: fs.statSync(exe).size, archive: fs.statSync(archive).size };
}

/** SHA256SUMS for every archive in `out`, in sha256sum's format. */
export function writeSums(out = path.join(root, "dist-bin")) {
	const archives = fs.readdirSync(out).filter((f) => f.endsWith(".tar.gz")).sort();
	fs.writeFileSync(path.join(out, "SHA256SUMS"), archives.map((f) => `${sha256(path.join(out, f))}  ${f}\n`).join(""));
	return archives;
}

/** Pack the named targets (or every one that's built) and write SHA256SUMS. */
export function packageAll(targets = [], out = path.join(root, "dist-bin")) {
	const built = targets.length > 0 ? targets : TARGETS.filter((t) => fs.existsSync(path.join(out, `vigent-${t}`, exeName(t))));
	if (built.length === 0) throw new Error(`nothing to pack: no dist-bin/vigent-<target>/${exeName("linux-x64")} is built`);
	for (const t of built) {
		const r = packageTarget(t, out);
		console.log(`${r.target.padEnd(20)} vigent ${mb(r.binary).padStart(9)}   archive ${mb(r.archive).padStart(8)}`);
	}
	writeSums(out);
	return built;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const argv = process.argv.slice(2);
		if (argv.includes("--list")) console.log(TARGETS.join("\n"));
		else packageAll(argv.filter((a) => !a.startsWith("-")));
	} catch (err) {
		console.error(`package-binaries: ${err.message}`);
		process.exit(1);
	}
}
