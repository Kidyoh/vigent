/**
 * Import any vim/nvim colorscheme into a Vigent theme.
 *
 * Shells out to `nvim --headless`, loads the colorscheme, dumps resolved
 * highlight groups via vim.api.nvim_get_hl(), and writes
 * ~/.config/vigent/themes/<name>.json keyed by highlight group name.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Attr, themesDir } from "./theme.js";

const DUMP_LUA = `
local out = {}
for name, hl in pairs(vim.api.nvim_get_hl(0, {})) do
  local resolved = hl
  if hl.link then
    resolved = vim.api.nvim_get_hl(0, { name = name, link = false })
  end
  local entry = {}
  if resolved.fg then entry.fg = string.format("#%06x", resolved.fg) end
  if resolved.bg then entry.bg = string.format("#%06x", resolved.bg) end
  if resolved.bold then entry.bold = true end
  if resolved.italic then entry.italic = true end
  if resolved.underline then entry.underline = true end
  if resolved.reverse then entry.reverse = true end
  if next(entry) ~= nil then out[name] = entry end
end
io.write(vim.json.encode(out))
`.trim();

export function importNvimTheme(colorscheme: string, outName?: string): string {
	let json: string;
	try {
		json = execFileSync(
			"nvim",
			[
				"--headless",
				"--clean",
				"-u",
				"NORC",
				`+set termguicolors`,
				`+colorscheme ${colorscheme}`,
				`+lua ${DUMP_LUA.replace(/\n/g, " ")}`,
				"+qa!",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (err: any) {
		if (err.code === "ENOENT") {
			throw new Error("nvim not found on PATH — theme import needs a local Neovim install");
		}
		// User themes usually live in the real config, retry without --clean
		try {
			json = execFileSync(
				"nvim",
				["--headless", `+set termguicolors`, `+colorscheme ${colorscheme}`, `+lua ${DUMP_LUA.replace(/\n/g, " ")}`, "+qa!"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch (err2: any) {
			throw new Error(`nvim could not load colorscheme '${colorscheme}': ${err2.stderr ?? err2.message}`);
		}
	}
	const start = json.indexOf("{");
	if (start < 0) throw new Error("nvim returned no highlight data");
	const groups = JSON.parse(json.slice(start)) as Record<string, Attr>;
	const name = outName ?? colorscheme;
	fs.mkdirSync(themesDir(), { recursive: true });
	const file = path.join(themesDir(), `${name}.json`);
	fs.writeFileSync(file, JSON.stringify({ name, groups }, null, "\t"));
	return file;
}
