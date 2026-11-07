/**
 * Nerd Font icons (`icons = "nerd"`), the glyphs AstroNvim, LazyVim and
 * nvim-web-devicons draw. They need a Nerd Font in the terminal
 * (https://www.nerdfonts.com); codepoints are Nerd Fonts v3.
 */

export type IconSet = "unicode" | "ascii" | "nerd";
export const ICON_SETS: IconSet[] = ["unicode", "nerd", "ascii"];

export const NERD = {
	branch: "", // nf-dev-git_branch
	check: "", // nf-fa-check
	times: "", // nf-fa-times
	warning: "", // nf-fa-warning
	circle: "", // nf-fa-circle
	circleO: "", // nf-fa-circle_o
	pause: "", // nf-fa-pause
	clock: "", // nf-fa-clock_o
	hourglass: "", // nf-fa-hourglass_half
	search: "", // nf-fa-search
	pencil: "", // nf-fa-pencil_square_o
	plus: "", // nf-fa-plus
	palette: "", // nf-fa-palette
	gear: "", // nf-fa-gear
	chip: "", // nf-fa-microchip
	bolt: "", // nf-fa-bolt
	keyboard: "", // nf-fa-keyboard_o
	power: "", // nf-fa-power_off
	terminal: "", // nf-oct-terminal
	file: "", // nf-fa-file
	fileText: "", // nf-fa-file_text
	globe: "", // nf-fa-globe
	wrench: "", // nf-fa-wrench
	list: "", // nf-fa-list
	caretRight: "", // nf-fa-caret_right
	caretDown: "", // nf-fa-caret_down
} as const;

/** An icon for a tool call, by the tool's name (Claude Code, Codex, OpenCode and pi names). */
export function toolIcon(name: string): string {
	const n = name.toLowerCase();
	if (/bash|shell|exec|command|run/.test(n)) return NERD.terminal;
	if (/edit|write|patch|apply/.test(n)) return NERD.pencil;
	if (/read|view|cat|open/.test(n)) return NERD.fileText;
	if (/grep|glob|search|find|^ls$|list/.test(n)) return NERD.search;
	if (/web|fetch|http|url/.test(n)) return NERD.globe;
	if (/todo|plan|task/.test(n)) return NERD.list;
	return NERD.wrench;
}

/**
 * A file's icon and the highlight group to color it with, by name or
 * extension (like nvim-web-devicons, colored from the theme).
 */
export function fileIcon(file: string): [glyph: string, group: string] {
	const base = file.split(/[/\\]/).pop()?.toLowerCase() ?? "";
	const byName: Record<string, [string, string]> = {
		"package.json": ["", "DiagnosticError"], // nf-dev-npm
		"package-lock.json": ["", "DiagnosticError"],
		dockerfile: ["", "DiagnosticInfo"], // nf-linux-docker
		".gitignore": ["", "DiagnosticWarn"], // nf-dev-git
		makefile: ["", "Comment"], // nf-dev-gnu
		license: ["", "DiagnosticWarn"], // nf-seti-license
	};
	if (byName[base]) return byName[base];
	const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
	const byExt: Record<string, [string, string]> = {
		ts: ["", "Function"], // nf-seti-typescript
		tsx: ["", "Function"], // nf-dev-react
		mts: ["", "Function"],
		js: ["", "DiagnosticWarn"], // nf-dev-javascript
		jsx: ["", "Function"],
		mjs: ["", "DiagnosticWarn"],
		cjs: ["", "DiagnosticWarn"],
		json: ["", "DiagnosticWarn"], // nf-seti-json
		md: ["", "Normal"], // nf-dev-markdown
		py: ["", "DiagnosticWarn"], // nf-dev-python
		rs: ["", "Special"], // nf-dev-rust
		go: ["", "Function"], // nf-seti-go
		lua: ["", "Function"], // nf-seti-lua
		vim: ["", "String"], // nf-seti-vim
		html: ["", "Special"], // nf-dev-html5
		css: ["", "Function"], // nf-dev-css3
		scss: ["", "Statement"],
		sh: ["", "String"], // nf-oct-terminal
		bash: ["", "String"],
		zsh: ["", "String"],
		toml: ["", "Comment"], // nf-seti-config
		yml: ["", "Comment"],
		yaml: ["", "Comment"],
		lock: ["", "Comment"], // nf-fa-lock
		svg: ["", "DiagnosticWarn"], // nf-fa-file_image_o
		png: ["", "Constant"],
		jpg: ["", "Constant"],
		java: ["", "DiagnosticError"], // nf-dev-java
		rb: ["", "DiagnosticError"], // nf-dev-ruby
		c: ["", "Function"], // nf-custom-c
		cpp: ["", "Function"], // nf-custom-cpp
		h: ["", "Statement"],
	};
	return byExt[ext] ?? [NERD.file, "Comment"];
}
