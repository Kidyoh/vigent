/**
 * Markdown for agent replies, in vim's highlight groups: headings (Title),
 * **bold**, *italic*, ~~strike~~, `code` and fenced code blocks (VigentCode),
 * links, bullet / numbered / task lists (nested), > quotes (Comment),
 * --- rules and tables. Code blocks are numbered so VISUAL-mode `ib` and
 * `yib` can select them.
 */
import { visibleWidth, wrapTextWithAnsi } from "./tui.js";
import { type Painter, RESET } from "./theme.js";

export interface MdLine {
	text: string;
	plain: string;
	/** index of the code block this line belongs to */
	block?: number;
	/** the block's language label line: part of the block for selection, not copied */
	label?: boolean;
}

export interface MdOptions {
	/** plain ASCII for table borders and rules (icons = "ascii") */
	ascii?: boolean;
}

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKE = "\x1b[9m";

/**
 * Inline markdown in `base`'s color: `code`, **bold**, *italic*, ~~strike~~,
 * [links](url) and <autolinks>. After each styled piece the base color comes
 * back, so the rest of the line keeps it.
 */
export function inline(P: Painter, text: string, base = "Normal", urls = true): string {
	const on = P.s(base);
	let out = on;
	const re =
		/(\\[\\`*_~[\]()#>+\-.!|])|(`+)([^`]|[^`].*?[^`])\2(?!`)|\*\*([^*\s](?:.*?[^*\s])??)\*\*|__([^_\s](?:.*?[^_\s])??)__|~~([^~\s](?:.*?[^~\s])??)~~|\*([^*\s](?:.*?[^*\s])??)\*|(?<![\w])_([^_\s](?:.*?[^_\s])??)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out += text.slice(last, m.index);
		last = m.index + m[0].length;
		if (m[1]) out += m[1].slice(1); // \* and friends: the character itself
		else if (m[2]) out += P.p("VigentCode", m[3].replace(/^ (.*) $/, "$1")) + on;
		else if (m[4] ?? m[5]) out += BOLD + inline(P, (m[4] ?? m[5]) as string, base, urls) + RESET + on;
		else if (m[6]) out += STRIKE + inline(P, m[6], base, urls) + RESET + on;
		else if (m[7] ?? m[8]) out += ITALIC + inline(P, (m[7] ?? m[8]) as string, base, urls) + RESET + on;
		else if (m[9]) {
			const label = m[9];
			const url = m[10];
			out += P.s("Special") + UNDERLINE + label + RESET + (urls && url !== label && !url.startsWith("#") ? P.p("Comment", ` (${url})`) : "") + on;
		} else if (m[11]) out += P.s("Special") + UNDERLINE + m[11] + RESET + on;
	}
	return out + text.slice(last) + RESET;
}

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// --- tables ---------------------------------------------------------------

type Align = "left" | "center" | "right";

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;

/** The cells of a table row: `| a | b |` → ["a", "b"] (a `\|` stays in its cell). */
function cells(row: string): string[] {
	let s = row.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isRow(line: string): boolean {
	return /\|/.test(line) && line.trim() !== "";
}

/**
 * A table as box-drawn lines that fit `width`: columns as wide as their
 * widest cell, shrunk (widest first) when the table is too wide, with cell
 * text wrapping inside its column.
 */
function renderTable(P: Painter, rows: string[][], aligns: Align[], width: number, ascii: boolean): MdLine[] {
	const g = ascii
		? { h: "-", v: "|", tl: "+", tm: "+", tr: "+", ml: "+", mm: "+", mr: "+", bl: "+", bm: "+", br: "+" }
		: { h: "─", v: "│", tl: "┌", tm: "┬", tr: "┐", ml: "├", mm: "┼", mr: "┤", bl: "└", bm: "┴", br: "┘" };
	const n = Math.max(...rows.map((r) => r.length));
	const styled = rows.map((r, ri) => Array.from({ length: n }, (_, c) => inline(P, r[c] ?? "", ri === 0 ? "Title" : "Normal", false)));
	const want = Array.from({ length: n }, (_, c) => Math.max(1, ...styled.map((r) => visibleWidth(strip(r[c])))));
	// borders and padding take 3 columns per cell, plus one
	const room = Math.max(n * 3, width - (3 * n + 1));
	const cols = [...want];
	while (cols.reduce((a, b) => a + b, 0) > room) {
		const widest = cols.indexOf(Math.max(...cols));
		if (cols[widest] <= 3) break;
		cols[widest]--;
	}
	const border = (l: string, m: string, r: string) => {
		const s = l + cols.map((w) => g.h.repeat(w + 2)).join(m) + r;
		return { text: P.p("NonText", s), plain: s };
	};
	const out: MdLine[] = [border(g.tl, g.tm, g.tr)];
	styled.forEach((row, ri) => {
		const wrapped = row.map((cell, c) => wrapTextWithAnsi(cell, cols[c]));
		const height = Math.max(...wrapped.map((w) => w.length));
		for (let li = 0; li < height; li++) {
			let text = P.p("NonText", g.v);
			for (let c = 0; c < n; c++) {
				const piece = wrapped[c][li] ?? "";
				const pad = Math.max(0, cols[c] - visibleWidth(strip(piece)));
				const a = aligns[c] ?? "left";
				const left = a === "right" ? pad : a === "center" ? Math.floor(pad / 2) : 0;
				text += ` ${" ".repeat(left)}${piece}${RESET}${" ".repeat(pad - left)} ${P.p("NonText", g.v)}`;
			}
			out.push({ text, plain: strip(text) });
		}
		if (ri === 0) out.push(border(g.ml, g.mm, g.mr));
	});
	out.push(border(g.bl, g.bm, g.br));
	return out;
}

// --- blocks ---------------------------------------------------------------

/** Render markdown into wrapped, styled lines. `bullet` is the list marker glyph. */
export function renderMarkdown(text: string, width: number, P: Painter, bullet = "•", startBlock = 0, opts: MdOptions = {}): { lines: MdLine[]; blocks: number } {
	const lines: MdLine[] = [];
	const w = Math.max(10, width);
	let block = startBlock;
	let fence: string | undefined;
	const push = (styled: string, prefix = "", rest = prefix) => {
		const wrapped = wrapTextWithAnsi(styled, Math.max(4, w - visibleWidth(strip(prefix))));
		wrapped.forEach((l, i) => {
			const t = (i === 0 ? prefix : rest) + l;
			lines.push({ text: t, plain: strip(t) });
		});
	};

	const src = text.split("\n");
	for (let i = 0; i < src.length; i++) {
		const raw = src[i];
		const open = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(raw);
		if (fence !== undefined) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !open[2]) {
				fence = undefined;
				block++;
				continue;
			}
			// code is not wrapped on words; long lines are cut by the pane
			lines.push({ text: `  ${P.p("VigentCode", raw)}`, plain: `  ${raw}`, block });
			continue;
		}
		if (open) {
			fence = open[1];
			lines.push({ text: P.p("NonText", `  ${open[2] || "code"}`), plain: `  ${open[2] || "code"}`, block, label: true });
			continue;
		}

		// a table: a row, then a | --- | separator
		if (isRow(raw) && i + 1 < src.length && SEPARATOR.test(src[i + 1]) && cells(raw).length > 0) {
			const aligns = cells(src[i + 1]).map((c): Align => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
			const rows = [cells(raw)];
			let j = i + 2;
			while (j < src.length && isRow(src[j]) && !SEPARATOR.test(src[j])) rows.push(cells(src[j++]));
			lines.push(...renderTable(P, rows, aligns, w, !!opts.ascii));
			i = j - 1;
			continue;
		}

		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
		if (heading) {
			const body = inline(P, heading[2], "Title");
			push(heading[1].length <= 2 ? BOLD + body : body);
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
			const rule = (opts.ascii ? "-" : "─").repeat(Math.min(w, 60));
			lines.push({ text: P.p("NonText", rule), plain: rule });
			continue;
		}
		const quote = /^\s{0,3}((?:>\s?)+)(.*)$/.exec(raw);
		if (quote) {
			const depth = (quote[1].match(/>/g) ?? []).length;
			const bar = P.p("Comment", "▏ ".repeat(depth));
			push(inline(P, quote[2], "Comment"), bar);
			continue;
		}
		const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw);
		if (item) {
			const level = Math.min(6, Math.floor(item[1].replace(/\t/g, "  ").length / 2));
			const indent = "  ".repeat(level);
			const ordered = /\d/.test(item[2]);
			let marker = ordered ? item[2] : bullet;
			if (item[3]) marker = /x/i.test(item[3]) ? (opts.ascii ? "[x]" : "☑") : opts.ascii ? "[ ]" : "☐";
			const lead = `${indent}${P.p(item[3] ? (/x/i.test(item[3]) ? "String" : "Comment") : "Special", marker)} `;
			push(inline(P, item[4]), lead, " ".repeat(visibleWidth(strip(lead))));
			continue;
		}
		push(raw.trim() === "" ? "" : inline(P, raw));
	}
	if (fence !== undefined) block++;
	return { lines, blocks: block - startBlock };
}
