/** Which vigent is running: the package version, plus the git commit when it runs from a clone. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const VERSION: string = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0";
	} catch {
		return "0";
	}
})();

/** The short commit vigent was built from, when it runs from a git clone (npm link); else undefined. */
export const COMMIT: string | undefined = (() => {
	if (!fs.existsSync(new URL("../.git", import.meta.url))) return undefined;
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
})();

/** "0.2.0 (ed9418d)" from a clone, "0.2.0" from npm. */
export const VERSION_TEXT = COMMIT ? `${VERSION} (${COMMIT})` : VERSION;
