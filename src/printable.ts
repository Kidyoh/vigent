/**
 * An agent's text made safe to draw inside a window. A terminal acts on control
 * characters instead of showing them: a tab jumps to the next tab stop, `\r`
 * goes back to the start of the row, and a cursor or erase sequence moves or
 * clears the whole row. Any of them puts text outside the window it belongs to,
 * over the window beside it or, once a row wraps, pushing the windows below down.
 *
 * Colors (SGR) and links (OSC 8) stay. Tabs become two spaces, like the diff
 * view. A lone `\r` keeps what came after it, which is what a progress bar ends
 * up showing. Every other escape sequence and control character is dropped.
 */
export function printable(text: string): string {
	if (!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(text)) return text;
	return text
		.replace(/\r\n/g, "\n")
		.replace(ESCAPE, (seq) => (SGR.test(seq) || OSC8.test(seq) ? seq : ""))
		.split("\n")
		.map((line) => line.slice(line.lastIndexOf("\r") + 1))
		.join("\n")
		.replace(/\t/g, "  ")
		.replace(/(\x1b(?:\[[0-9;:]*m|\]8;[^\x07\x1b]*(?:\x07|\x1b\\)))|[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (m, keep) => keep ?? "");
}

/** CSI, OSC, DCS/SOS/PM/APC strings, and two-byte escapes, in their 7-bit forms */
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]*[0-~]?/g;
const SGR = /^\x1b\[[0-9;:]*m$/;
const OSC8 = /^\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)$/;
