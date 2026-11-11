/**
 * The standalone builds (scripts/build-binary.mjs), installed without npm:
 *
 * - the binary: vigent compiled together with its runtime, for machines
 *   without Node
 * - the small build: vigent as one JavaScript file, for machines that have Node
 *
 * Neither has a package.json or node_modules next to it, so what the npm
 * install reads from those is put in when it's built, or sits beside the file.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Replaced with the version when a standalone build is made; not defined anywhere else. */
declare const VIGENT_STANDALONE_VERSION: string | undefined;
/** Replaced with "node" in the small build. */
declare const VIGENT_STANDALONE_KIND: string | undefined;

/** The version this binary was built as; undefined when vigent runs on Node from npm or a clone. */
export const STANDALONE_VERSION: string | undefined = typeof VIGENT_STANDALONE_VERSION === "string" ? VIGENT_STANDALONE_VERSION : undefined;

export const STANDALONE = STANDALONE_VERSION !== undefined;

/** The small build: one JavaScript file that your Node runs. */
export const STANDALONE_ON_NODE = STANDALONE && typeof VIGENT_STANDALONE_KIND === "string" && VIGENT_STANDALONE_KIND === "node";

/** What was installed: the binary itself, or the small build's file (Node is somewhere else). */
const installedFile = () => (STANDALONE_ON_NODE ? (process.argv[1] ?? process.execPath) : process.execPath);

/** The folder vigent really is in (a symlink on your PATH points here). */
export function standaloneDir(file = installedFile()): string {
	try {
		return path.dirname(fs.realpathSync(file));
	} catch {
		return path.dirname(file);
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
export function selfCommand(args: string[], standalone = STANDALONE && !STANDALONE_ON_NODE, execPath = process.execPath, script = process.argv[1]): { command: string; args: string[] } {
	return standalone ? { command: execPath, args } : { command: execPath, args: [script, ...args] };
}
