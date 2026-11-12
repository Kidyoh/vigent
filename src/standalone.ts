/**
 * The standalone binary: vigent compiled together with a JavaScript runtime
 * (scripts/build-binary.mjs). It's the stand-in until the Rust port has a
 * binary of its own, and exists so the release pipeline can be checked against
 * something real. There's no package.json or node_modules next to it, so what
 * the npm install reads from those is put in when it's built, or sits beside
 * the executable.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Replaced with the version when the binary is built; not defined anywhere else. */
declare const VIGENT_STANDALONE_VERSION: string | undefined;

/** The version this binary was built as; undefined when vigent runs on Node from npm or a clone. */
export const STANDALONE_VERSION: string | undefined = typeof VIGENT_STANDALONE_VERSION === "string" ? VIGENT_STANDALONE_VERSION : undefined;

export const STANDALONE = STANDALONE_VERSION !== undefined;

/** The folder the binary really is in (a symlink on your PATH points here). */
export function standaloneDir(execPath = process.execPath): string {
	try {
		return path.dirname(fs.realpathSync(execPath));
	} catch {
		return path.dirname(execPath);
	}
}

/** A program shipped beside the binary (`riftri`), if it's there. */
export function bundledBinary(name: string, dir = standaloneDir(), platform = process.platform): string | undefined {
	const file = path.join(dir, platform === "win32" ? `${name}.exe` : name);
	try {
		return fs.statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The command that runs vigent itself again with `args`: the binary alone, or
 * Node with the script it was started from.
 */
export function selfCommand(args: string[], standalone = STANDALONE, execPath = process.execPath, script = process.argv[1]): { command: string; args: string[] } {
	return standalone ? { command: execPath, args } : { command: execPath, args: [script, ...args] };
}
