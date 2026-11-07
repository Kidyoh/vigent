/**
 * Vim `:highlight` syntax support.
 *
 * - parseHighlightCommand(): the arguments of a single `:hi` command
 *   (used by the in-app `:hi` command and by the file parser)
 * - parseVimColorscheme(): a static reader for `.vim` colorscheme files, so
 *   classic vim themes can be imported without vim or nvim installed
 */
import { resolveVimColor } from "./color.js";
import type { Attr } from "./theme.js";

export type HiCommand =
	| { kind: "set"; group: string; attr: Attr; raw: RawHi }
	| { kind: "link"; from: string; to: string }
	| { kind: "clear"; group?: string }
	| { kind: "show"; group: string };

/** Raw key/values as vim stores them before gui/cterm preference is applied. */
export interface RawHi {
	guifg?: string;
	guibg?: string;
	gui?: string;
	ctermfg?: string;
	ctermbg?: string;
	cterm?: string;
}

/** Split on whitespace, keeping 'quoted' and "quoted" values together. */
export function tokenize(s: string): string[] {
	const out: string[] = [];
	const re = /(\S+?=(?:'[^']*'|"[^"]*")|\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) out.push(m[1]);
	return out;
}

const ATTR_WORDS: Record<string, keyof Attr> = {
	bold: "bold",
	italic: "italic",
	underline: "underline",
	undercurl: "underline",
	underdouble: "underline",
	underdotted: "underline",
	underdashed: "underline",
	reverse: "reverse",
	inverse: "reverse",
	standout: "reverse",
};

function applyAttrList(list: string, attr: Attr) {
	for (const word of list.toLowerCase().split(",")) {
		if (word === "none") {
			attr.bold = attr.italic = attr.underline = attr.reverse = false;
			continue;
		}
		const key = ATTR_WORDS[word];
		if (key) (attr as Record<string, boolean>)[key] = true;
	}
}

/**
 * Convert raw vim values to an Attr, preferring GUI colors over cterm ones.
 * With keepOff, attributes turned off by `gui=NONE` stay as `false` so they
 * can switch off a theme's bold/italic when merged as an override.
 */
export function rawToAttr(raw: RawHi, keepOff = false): Attr {
	const attr: Attr = {};
	const fg = raw.guifg ? resolveVimColor(raw.guifg) : undefined;
	const bg = raw.guibg ? resolveVimColor(raw.guibg) : undefined;
	attr.fg = fg ?? (raw.ctermfg ? resolveVimColor(raw.ctermfg, true) : undefined);
	attr.bg = bg ?? (raw.ctermbg ? resolveVimColor(raw.ctermbg, true) : undefined);
	const attrs = raw.gui ?? raw.cterm;
	if (attrs) applyAttrList(attrs, attr);
	for (const k of Object.keys(attr) as (keyof Attr)[]) {
		if (attr[k] === undefined || (attr[k] === false && !keepOff)) delete attr[k];
	}
	return attr;
}

/**
 * Parse the arguments of a `:highlight` command (everything after `hi`).
 * Accepts vim keys (guifg, guibg, gui, ctermfg, ctermbg, cterm) plus the
 * nvim_set_hl-style shorthands fg=, bg=, and bare words like `bold`.
 */
export function parseHighlightCommand(args: string): HiCommand | undefined {
	let tokens = tokenize(args.trim());
	if (tokens[0] === "!") tokens = tokens.slice(1);
	if (tokens[0] === "default" || tokens[0] === "def") tokens = tokens.slice(1);
	if (tokens.length === 0) return undefined;

	if (tokens[0] === "clear") return { kind: "clear", group: tokens[1] };
	if (tokens[0] === "link") {
		if (tokens.length < 3) return undefined;
		return { kind: "link", from: tokens[1], to: tokens[2] };
	}

	const group = tokens[0];
	if (tokens.length === 1) return { kind: "show", group };

	const raw: RawHi = {};
	const extra: Attr = {};
	for (const tok of tokens.slice(1)) {
		const eq = tok.indexOf("=");
		if (eq < 0) {
			applyAttrList(tok, extra);
			continue;
		}
		const key = tok.slice(0, eq).toLowerCase();
		const value = tok.slice(eq + 1).replace(/^["']|["']$/g, "");
		switch (key) {
			case "guifg":
			case "fg":
				raw.guifg = value;
				break;
			case "guibg":
			case "bg":
				raw.guibg = value;
				break;
			case "gui":
				raw.gui = value;
				break;
			case "ctermfg":
				raw.ctermfg = value;
				break;
			case "ctermbg":
				raw.ctermbg = value;
				break;
			case "cterm":
				raw.cterm = value;
				break;
			// guisp, term, font, blend, start, stop: not used by a terminal UI
		}
	}
	return { kind: "set", group, attr: { ...rawToAttr(raw, true), ...extra }, raw };
}

interface Frame {
	active: boolean;
	taken: boolean;
	parentActive: boolean;
}

/** Evaluate an `if` condition. Only `&background` checks are understood; anything else is assumed true. */
function evalCondition(cond: string, background: "dark" | "light"): boolean {
	const m = /&(?:background|bg)\s*(==|!=|is|isnot)[#?]?\s*['"](dark|light)['"]/.exec(cond);
	if (!m) return true;
	const equal = m[2] === background;
	return m[1] === "==" || m[1] === "is" ? equal : !equal;
}

export interface ParsedColorscheme {
	name?: string;
	background: "dark" | "light";
	groups: Record<string, Attr>;
}

/** Statically read a `.vim` colorscheme file. Lines built at runtime (exe, functions) are skipped. */
export function parseVimColorscheme(text: string, background?: "dark" | "light"): ParsedColorscheme {
	// join line continuations ("\" at the start of the next line)
	const lines = text.replace(/\r/g, "").replace(/\n\s*\\/g, " ").split("\n");

	const setBg = /^\s*set\s+(?:background|bg)=(dark|light)/m.exec(text);
	const bg: "dark" | "light" = background ?? (setBg ? (setBg[1] as "dark" | "light") : "dark");

	const raw: Record<string, RawHi> = {};
	const links: Record<string, string> = {};
	const stack: Frame[] = [];
	let name: string | undefined;
	const active = () => (stack.length === 0 ? true : stack[stack.length - 1].active);

	for (const original of lines) {
		const line = original.trim();
		if (line === "" || line.startsWith('"')) continue;

		let m: RegExpExecArray | null;
		if ((m = /^if\s+(.*)$/.exec(line))) {
			const parentActive = active();
			const ok = parentActive && evalCondition(m[1], bg);
			stack.push({ active: ok, taken: ok, parentActive });
			continue;
		}
		if ((m = /^elseif\s+(.*)$/.exec(line))) {
			const f = stack[stack.length - 1];
			if (!f) continue;
			const ok = f.parentActive && !f.taken && evalCondition(m[1], bg);
			f.active = ok;
			f.taken ||= ok;
			continue;
		}
		if (/^else\b/.test(line)) {
			const f = stack[stack.length - 1];
			if (!f) continue;
			f.active = f.parentActive && !f.taken;
			f.taken = true;
			continue;
		}
		if (/^endif\b/.test(line)) {
			stack.pop();
			continue;
		}
		if (!active()) continue;
		if (/^fini(sh)?\b/.test(line)) break;

		if ((m = /^let\s+g:colors_name\s*=\s*['"]([^'"]+)['"]/.exec(line))) {
			name = m[1];
			continue;
		}

		if ((m = /^hi(?:g|gh|ghl|ghli|ghlig|ghligh|ghlight)?(!?)\s+(.*)$/.exec(line))) {
			const cmd = parseHighlightCommand(m[2].replace(/\s+"[^"]*$/, ""));
			if (!cmd) continue;
			if (cmd.kind === "link") {
				links[cmd.from] = cmd.to;
			} else if (cmd.kind === "set") {
				raw[cmd.group] = { ...raw[cmd.group], ...cmd.raw };
				// a group with its own colors stops following a link, as in vim
				if (cmd.raw.guifg || cmd.raw.guibg || cmd.raw.ctermfg || cmd.raw.ctermbg) delete links[cmd.group];
			}
		}
	}

	const groups: Record<string, Attr> = {};
	for (const [group, r] of Object.entries(raw)) {
		const attr = rawToAttr(r);
		if (Object.keys(attr).length > 0) groups[group] = attr;
	}
	for (const [from, to] of Object.entries(links)) {
		if (!groups[from]) groups[from] = { link: to };
	}
	return { name, background: bg, groups };
}
