/**
 * :diff layouts for the floating diff window.
 *
 * unified: git's own output, colored.
 * split:   side by side, old on the left and new on the right, with line
 *          numbers; removed and added lines are paired up row by row.
 *
 * Both return the line indices of hunk headers so ]c / [c can jump.
 */
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { FloatLine } from "./float.js";

export interface DiffView {
	lines: FloatLine[];
	jumps: number[];
}

function lineGroup(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return "Title";
	if (line.startsWith("+")) return "Added";
	if (line.startsWith("-")) return "Removed";
	if (line.startsWith("@@")) return "Special";
	if (/^(diff --git|index |new file|deleted file|similarity|rename )/.test(line)) return "Comment";
	return "NormalFloat";
}

export function unifiedView(text: string): DiffView {
	const raw = text.replace(/\n$/, "").split("\n");
	return {
		lines: raw.map((l) => [[lineGroup(l), l]]),
		jumps: raw.map((l, i) => (l.startsWith("@@") ? i : -1)).filter((i) => i >= 0),
	};
}

function cell(no: number | undefined, text: string | undefined, width: number, group: string): [string, string][] {
	if (text === undefined) return [["NonText", " ".repeat(width)]];
	const num = no === undefined ? "    " : String(no).padStart(4);
	const body = truncateToWidth(text.replace(/\t/g, "  "), Math.max(0, width - 5), "…");
	return [
		["LineNr", `${num} `],
		[group, body + " ".repeat(Math.max(0, width - 5 - visibleWidth(body)))],
	];
}

/** Side-by-side layout for a window `width` columns wide (inside its border). */
export function splitView(text: string, width: number): DiffView {
	const col = Math.max(12, Math.floor((width - 3) / 2));
	const lines: FloatLine[] = [];
	const jumps: number[] = [];
	let oldNo = 0;
	let newNo = 0;
	let dels: { no: number; text: string }[] = [];
	let adds: { no: number; text: string }[] = [];

	const row = (l?: { no: number; text: string }, r?: { no: number; text: string }, lg = "NormalFloat", rg = "NormalFloat") =>
		lines.push([...cell(l?.no, l?.text, col, lg), ["NonText", " │ "], ...cell(r?.no, r?.text, col, rg)]);
	const flush = () => {
		for (let i = 0; i < Math.max(dels.length, adds.length); i++) row(dels[i], adds[i], "Removed", "Added");
		dels = [];
		adds = [];
	};

	for (const line of text.replace(/\n$/, "").split("\n")) {
		if (line.startsWith("diff --git")) {
			flush();
			if (lines.length > 0) lines.push([]);
			continue;
		}
		const file = /^\+\+\+ (?:b\/)?(.*)$/.exec(line);
		if (file) {
			lines.push([["Title", file[1] === "/dev/null" ? "(deleted file)" : file[1]]]);
			continue;
		}
		if (/^(---|index |new file|deleted file|similarity|rename |\\ No newline)/.test(line)) continue;
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
		if (hunk) {
			flush();
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			jumps.push(lines.length);
			lines.push([["Special", line]]);
			continue;
		}
		if (line.startsWith("-")) {
			dels.push({ no: oldNo++, text: line.slice(1) });
		} else if (line.startsWith("+")) {
			adds.push({ no: newNo++, text: line.slice(1) });
		} else {
			flush();
			const t = line.startsWith(" ") ? line.slice(1) : line;
			row({ no: oldNo++, text: t }, { no: newNo++, text: t });
		}
	}
	flush();
	return { lines, jumps };
}
