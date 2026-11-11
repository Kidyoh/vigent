/**
 * `theme = "nvim"` (or `"vim"`): vigent uses the colorscheme your editor
 * uses, with your config and plugins (AstroNvim, LazyVim, NvChad...).
 *
 * The editor's colors are kept as the theme file `nvim.json` (`vim.json`).
 * At start vigent shows that copy at once, and imports again in the
 * background: when you've changed your editor's colorscheme since, the new
 * one replaces it while vigent runs. The first time there's no copy yet, so
 * vigent imports before it opens.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { importTheme } from "./import.js";
import { selfCommand, STANDALONE } from "./standalone.js";
import { loadTheme, type Theme, themesDir } from "./theme.js";

export const FOLLOW_EDITORS = ["nvim", "vim"] as const;
export type FollowEditor = (typeof FOLLOW_EDITORS)[number];

export function isFollow(theme: string | undefined): theme is FollowEditor {
	return (FOLLOW_EDITORS as readonly string[]).includes(theme ?? "");
}

/** The theme file that holds the editor's colors. */
export function followFile(editor: FollowEditor, dir = themesDir()): string {
	return path.join(dir, `${editor}.json`);
}

/** The colorscheme the copy came from (e.g. "astrodark"), if it says. */
export function followedColorscheme(editor: FollowEditor, dir = themesDir()): string | undefined {
	try {
		const c = JSON.parse(fs.readFileSync(followFile(editor, dir), "utf8")).colorscheme;
		return typeof c === "string" && c ? c : undefined;
	} catch {
		return undefined;
	}
}

/** The editor's theme: the copy from last time, or (the first time) an import now. Throws if the editor can't say. */
export function followTheme(editor: FollowEditor, dir = themesDir()): Theme {
	const file = followFile(editor, dir);
	if (!fs.existsSync(file)) importTheme({ editor, as: editor, outDir: dir });
	return loadTheme(file);
}

/** The copy's colors in a fixed order (the editor lists its groups in any order). */
function read(file: string): string | undefined {
	try {
		const sorted = (v: unknown): unknown =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
				: v;
		return JSON.stringify(sorted(JSON.parse(fs.readFileSync(file, "utf8"))));
	} catch {
		return undefined;
	}
}

/**
 * Import the editor's colorscheme again without blocking (in a child
 * `vigent theme import`); `onChange` gets the theme when it differs from the copy.
 */
export function refreshFollow(editor: FollowEditor, onChange: (theme: Theme) => void, cli = process.argv[1]): void {
	const file = followFile(editor);
	const before = read(file);
	// the standalone binary is the command itself; on Node it's node and the script
	const self = selfCommand(["theme", "import", `--${editor}`, "--as", editor], STANDALONE, process.execPath, cli);
	const child = spawn(self.command, self.args, { stdio: "ignore" });
	child.on("error", () => {});
	child.on("exit", (code) => {
		if (code !== 0) return;
		const after = read(file);
		if (after === undefined || after === before) return;
		try {
			onChange(loadTheme(file));
		} catch {
			// a copy that doesn't load: keep what's on screen
		}
	});
}
