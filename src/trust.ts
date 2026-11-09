/**
 * Which projects' .vigent.toml may run commands.
 *
 * A project config can set the theme, templates, keys and worktree layout
 * freely. The parts that run programs (hooks, engine arguments, custom
 * engine commands, shell commands under [commands], Claude Code
 * permission rules) only count once you trust that file, like direnv's
 * `allow`: `:trust` in vigent, or `vigent trust` in the project. Trust is
 * for the file as it is now; if it changes, vigent asks again.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function stateFile(): string {
	const xdg = process.env.XDG_STATE_HOME;
	return path.join(xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state"), "vigent", "trusted.json");
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

function read(): Record<string, string> {
	try {
		const v = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
}

/** Whether this file, with exactly this content, is trusted. */
export function isTrusted(file: string, content: string): boolean {
	return read()[path.resolve(file)] === digest(content);
}

/** Trust this file as it is now. */
export function trustFile(file: string, content: string): void {
	const all = read();
	all[path.resolve(file)] = digest(content);
	const f = stateFile();
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, `${JSON.stringify(all, null, 2)}\n`);
}
