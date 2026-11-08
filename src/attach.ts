/**
 * `@path` in a prompt attaches a file from the agent's folder.
 *
 * Each engine gets it its own way: Claude Code reads `@path` in a prompt
 * itself; OpenCode takes the files with `-f`; for Codex and pi, vigent adds
 * the file's contents under the prompt. The transcript shows what you typed.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineId } from "./engines.js";

/** files larger than this aren't inlined (Codex, pi) */
export const MAX_INLINE_BYTES = 100 * 1024;

/** The files an agent can be pointed at: tracked and new ones, without what .gitignore hides. */
export function listFiles(cwd: string): Promise<string[]> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => {
				if (err) return resolve(walk(cwd));
				const files = [...new Set(String(stdout).split("\0").filter(Boolean))].filter((f) => fs.existsSync(path.join(cwd, f)));
				resolve(files.sort(byDepthThenName));
			},
		);
	});
}

/** Not a git repository: a shallow walk, skipping the usual heavy folders. */
function walk(cwd: string, max = 5000): string[] {
	const out: string[] = [];
	const skip = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".venv", "venv"]);
	const visit = (dir: string, depth: number) => {
		if (out.length >= max || depth > 6) return;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const rel = dir ? `${dir}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!skip.has(e.name) && !e.name.startsWith(".")) visit(rel, depth + 1);
			} else if (e.isFile()) out.push(rel);
		}
	};
	visit("", 0);
	return out.sort(byDepthThenName);
}

function byDepthThenName(a: string, b: string): number {
	return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

/** a path that can follow `@`: letters, digits, `_ . / @ + -`, not ending in `.` or `@` (so "see @a.js." works) */
const PATH = String.raw`[\p{L}\p{N}_./@+-]*[\p{L}\p{N}_/+-]`;
/** `@path` at the start of a word; group 1 is the path */
export const MENTION = new RegExp(String.raw`(?:^|(?<=\s))@(${PATH})`, "gu");

/** Whether `@file` would read back as this file (names with spaces can't). */
export function mentionable(file: string): boolean {
	return new RegExp(`^${PATH}$`, "u").test(file);
}

/** The `@path` mentions in a prompt that name files in `cwd` (in order, once each). */
export function mentions(prompt: string, cwd: string): string[] {
	const out: string[] = [];
	for (const m of prompt.matchAll(MENTION)) {
		const rel = m[1];
		const abs = path.resolve(cwd, rel);
		if (!abs.startsWith(path.resolve(cwd) + path.sep) && abs !== path.resolve(cwd)) continue; // stays inside the folder
		if (!out.includes(rel) && fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(rel);
	}
	return out;
}

export interface Expanded {
	/** what the engine gets as the prompt */
	prompt: string;
	/** files to pass separately (OpenCode -f) */
	files: string[];
	/** files that were mentioned but not attached, and why */
	skipped: string[];
}

/** Turn a prompt with `@path` mentions into what this engine needs. */
export function expandPrompt(prompt: string, engine: EngineId, cwd: string): Expanded {
	const files = mentions(prompt, cwd);
	if (files.length === 0) return { prompt, files: [], skipped: [] };
	if (engine === "claude") return { prompt, files: [], skipped: [] }; // Claude Code reads @path itself
	if (engine === "opencode") return { prompt, files: files.map((f) => path.join(cwd, f)), skipped: [] };
	const blocks: string[] = [];
	const skipped: string[] = [];
	for (const f of files) {
		const buf = fs.readFileSync(path.join(cwd, f));
		if (buf.includes(0)) {
			skipped.push(`${f} (binary)`);
			continue;
		}
		if (buf.length > MAX_INLINE_BYTES) {
			skipped.push(`${f} (${Math.round(buf.length / 1024)} KB, over ${MAX_INLINE_BYTES / 1024} KB)`);
			continue;
		}
		const text = buf.toString("utf8");
		blocks.push(`<file path="${f}">\n${text}${text.endsWith("\n") ? "" : "\n"}</file>`);
	}
	if (blocks.length === 0) return { prompt, files: [], skipped };
	return { prompt: `${prompt}\n\nAttached files:\n\n${blocks.join("\n\n")}`, files: [], skipped };
}
