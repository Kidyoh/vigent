/** Which vigent is running: the package version, plus the git commit when it runs from a clone. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { STANDALONE, STANDALONE_VERSION } from "./standalone.js";

const root = fileURLToPath(new URL("..", import.meta.url));

export const VERSION: string = (() => {
	// the standalone binary has no package.json beside it: its version was put in when it was built
	if (STANDALONE_VERSION !== undefined) return STANDALONE_VERSION;
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0";
	} catch {
		return "0";
	}
})();

/** The short commit vigent was built from, when it runs from a git clone (npm link); else undefined. */
export const COMMIT: string | undefined = (() => {
	if (STANDALONE || !fs.existsSync(new URL("../.git", import.meta.url))) return undefined;
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
})();

/** "0.2.0 (ed9418d)" from a clone, "0.2.0" from npm. */
export const VERSION_TEXT = COMMIT ? `${VERSION} (${COMMIT})` : VERSION;

/**
 * In a clone: is the compiled code older than the source? (`git pull` without
 * `npm install` / `npm run build` leaves dist/ behind, and the new themes and
 * commands seem missing.) Returns the warning to show, or undefined.
 */
export function staleBuild(dir = root): string | undefined {
	const src = `${dir}/src`;
	const built = `${dir}/dist/cli.js`;
	if (STANDALONE || !fs.existsSync(`${dir}/.git`) || !fs.existsSync(src) || !fs.existsSync(built)) return undefined;
	try {
		const builtAt = fs.statSync(built).mtimeMs;
		const newer = fs.readdirSync(src).some((f) => f.endsWith(".ts") && fs.statSync(`${src}/${f}`).mtimeMs > builtAt + 1000);
		return newer ? `this vigent was built before its source last changed: run  npm install  (or  npm run build ) in ${dir.replace(/\/$/, "")}` : undefined;
	} catch {
		return undefined;
	}
}
