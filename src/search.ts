/**
 * Transcript search, like Neovim's with 'incsearch', 'hlsearch' and
 * 'smartcase': where a term occurs, and the occurrences painted into an
 * already-styled line without losing the line's own colors.
 */
import { RESET } from "./theme.js";

/** smartcase: case-insensitive unless the term has a capital letter */
export function foldCase(term: string, text: string): string {
	return /[A-Z]/.test(term) ? text : text.toLowerCase();
}

/** Where `term` starts in `text`, every time (not overlapping). */
export function occurrences(term: string, text: string): number[] {
	if (!term) return [];
	const needle = foldCase(term, term);
	const hay = foldCase(term, text);
	const out: number[] = [];
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push(at);
	return out;
}

/** One match: the `n`th occurrence on pane line `line`. */
export interface Hit {
	line: number;
	n: number;
}

/** Every match in the lines, top to bottom. */
export function findHits(term: string, lines: { plain: string }[]): Hit[] {
	const out: Hit[] = [];
	lines.forEach((l, line) => occurrences(term, l.plain).forEach((_, n) => out.push({ line, n })));
	return out;
}

const before = (a: Hit, b: Hit) => a.line < b.line || (a.line === b.line && a.n < b.n);

/**
 * The next match after `from` (before it when dir is -1), wrapping around
 * like 'wrapscan'. `nth` counts from 1, for the [nth/total] Neovim shows.
 */
export function nextHit(hits: Hit[], from: Hit, dir: 1 | -1): { hit: Hit; nth: number; wrapped: boolean } | undefined {
	if (!hits.length) return undefined;
	let i = -1;
	if (dir > 0) i = hits.findIndex((h) => before(from, h));
	else for (let j = hits.length - 1; j >= 0 && i < 0; j--) if (before(hits[j], from)) i = j;
	const wrapped = i < 0;
	if (wrapped) i = dir > 0 ? 0 : hits.length - 1;
	return { hit: hits[i], nth: i + 1, wrapped };
}

/** A CSI (colors, \x1b[…m) or OSC (links, \x1b]…\x07) sequence at `i`, if one starts there. */
function escapeAt(s: string, i: number): string | undefined {
	if (s[i] !== "\x1b") return undefined;
	return /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(s.slice(i, i + 64))?.[0] ?? /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(s.slice(i))?.[0];
}

/**
 * Paint every occurrence of `term` in a styled line with `on` (the current
 * one, the `current`th, with `cur`). After each, the line's own style comes
 * back: `base` (the pane's background), then the colors set since the last reset.
 */
export function paintMatches(styled: string, term: string, on: string, base: string, current = -1, cur = on): string {
	let plain = "";
	for (let i = 0; i < styled.length; ) {
		const esc = escapeAt(styled, i);
		if (esc) i += esc.length;
		else plain += styled[i++];
	}
	const starts = occurrences(term, plain);
	if (!starts.length) return styled;
	const len = term.length;
	let out = "";
	let active = ""; // colors set since the last reset
	let p = 0; // index into the plain text
	let k = 0; // the occurrence we're in or before
	let inside = false;
	for (let i = 0; i < styled.length; ) {
		const esc = escapeAt(styled, i);
		if (esc) {
			i += esc.length;
			if (esc.endsWith("m") && esc.startsWith("\x1b[")) active = /^\x1b\[0?m$/.test(esc) ? "" : active + esc;
			// inside a match its colors win; links still open and close
			if (!inside || !esc.endsWith("m")) out += esc;
			continue;
		}
		if (!inside && k < starts.length && p === starts[k]) {
			out += k === current ? cur : on;
			inside = true;
		}
		out += styled[i++];
		p++;
		if (inside && p === starts[k] + len) {
			out += RESET + base + active;
			inside = false;
			k++;
		}
	}
	return out;
}
