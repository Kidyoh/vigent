/**
 * Just enough markdown for agent replies, in vim's highlight groups:
 * headings (Title), **bold**, `code` and fenced code blocks (VigentCode),
 * bullet lists, and > quotes (Comment). Code blocks are numbered so
 * VISUAL-mode `ib` and `yib` can select them.
 */
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { type Painter, RESET } from "./theme.js";

export interface MdLine {
	text: string;
	plain: string;
	/** index of the code block this line belongs to */
	block?: number;
	/** the block's language label line: part of the block for selection, not copied */
	label?: boolean;
}

function inline(P: Painter, text: string): string {
	let out = "";
	const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		out += text.slice(last, m.index);
		const tok = m[0];
		if (tok.startsWith("`")) out += P.p("VigentCode", tok.slice(1, -1));
		else out += P.s("Normal") + "\x1b[1m" + tok.slice(2, -2) + RESET;
		last = m.index + tok.length;
	}
	return out + text.slice(last);
}

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Render markdown into wrapped, styled lines. `bullet` is the list marker glyph. */
export function renderMarkdown(text: string, width: number, P: Painter, bullet = "•", startBlock = 0): { lines: MdLine[]; blocks: number } {
	const lines: MdLine[] = [];
	let block = startBlock;
	let inFence = false;
	const push = (styled: string) => {
		for (const l of wrapTextWithAnsi(styled, Math.max(10, width))) lines.push({ text: l, plain: strip(l) });
	};

	for (const raw of text.split("\n")) {
		const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(raw);
		if (fence) {
			if (!inFence) {
				inFence = true;
				lines.push({ text: P.p("NonText", `  ${fence[2] || "code"}`), plain: `  ${fence[2] || "code"}`, block, label: true });
			} else {
				inFence = false;
				block++;
			}
			continue;
		}
		if (inFence) {
			// code is not wrapped on words; long lines are cut by the pane
			lines.push({ text: `  ${P.p("VigentCode", raw)}`, plain: `  ${raw}`, block });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
		if (heading) {
			push(P.p("Title", heading[2]));
			continue;
		}
		const item = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
		if (item) {
			const indent = item[1].length > 0 ? "  " : "";
			const body = wrapTextWithAnsi(inline(P, item[2]), Math.max(10, width - 2 - indent.length));
			body.forEach((l, i) => {
				const prefix = i === 0 ? `${indent}${P.p("Special", bullet)} ` : `${indent}  `;
				lines.push({ text: prefix + l, plain: strip(prefix + l) });
			});
			continue;
		}
		const quote = /^>\s?(.*)$/.exec(raw);
		if (quote) {
			push(P.p("Comment", `▏${quote[1]}`));
			continue;
		}
		push(inline(P, raw));
	}
	if (inFence) block++;
	return { lines, blocks: block - startBlock };
}
