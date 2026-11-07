/** Color helpers: hex math, xterm-256 palette, and vim color names. */

export type Rgb = [number, number, number];

export function parseHex(hex: string | undefined): Rgb | null {
	if (!hex) return null;
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function toHex([r, g, b]: Rgb): string {
	const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

/** Blend a toward b by t (0..1). Returns a unchanged if either color is invalid. */
export function mix(a: string, b: string, t: number): string {
	const x = parseHex(a);
	const y = parseHex(b);
	if (!x || !y) return a;
	return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex: string): number {
	const c = parseHex(hex);
	if (!c) return 0;
	const [r, g, b] = c.map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isLight(hex: string | undefined): boolean {
	return hex ? luminance(hex) > 0.35 : false;
}

const XTERM_16 = [
	"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
	"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

/** Convert an xterm-256 color index to hex. */
export function xterm256(n: number): string | undefined {
	if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
	if (n < 16) return XTERM_16[n];
	if (n < 232) {
		const levels = [0, 95, 135, 175, 215, 255];
		const i = n - 16;
		return toHex([levels[Math.floor(i / 36)], levels[Math.floor(i / 6) % 6], levels[i % 6]]);
	}
	const v = 8 + (n - 232) * 10;
	return toHex([v, v, v]);
}

/** Vim's cterm color names (ctermfg=DarkBlue) -> xterm index. */
const CTERM_NAMES: Record<string, number> = {
	black: 0, darkred: 1, darkgreen: 2, brown: 3, darkyellow: 3, darkblue: 4, darkmagenta: 5,
	darkcyan: 6, lightgray: 7, lightgrey: 7, gray: 7, grey: 7, darkgray: 8, darkgrey: 8,
	red: 9, lightred: 9, green: 10, lightgreen: 10, yellow: 11, lightyellow: 11, blue: 12,
	lightblue: 12, magenta: 13, lightmagenta: 13, cyan: 14, lightcyan: 14, white: 15,
};

/** Common GUI color names used by vim colorschemes (values from vim's rgb list). */
const GUI_NAMES: Record<string, string> = {
	black: "#000000", white: "#ffffff", red: "#ff0000", green: "#00ff00", blue: "#0000ff",
	yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff", gray: "#bebebe", grey: "#bebebe",
	darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
	darkred: "#8b0000", darkgreen: "#006400", darkblue: "#00008b", darkcyan: "#008b8b",
	darkmagenta: "#8b008b", darkyellow: "#bbbb00", brown: "#a52a2a", orange: "#ffa500",
	purple: "#a020f0", lightblue: "#add8e6", lightgreen: "#90ee90", lightcyan: "#e0ffff",
	lightred: "#ffbbbb", lightmagenta: "#ffbbff", lightyellow: "#ffffe0", seagreen: "#2e8b57",
	slateblue: "#6a5acd", gold: "#ffd700", khaki: "#f0e68c", navy: "#000080", wheat: "#f5deb3",
	peru: "#cd853f", salmon: "#fa8072", orangered: "#ff4500", skyblue: "#87ceeb",
	violet: "#ee82ee", tan: "#d2b48c", olive: "#808000", teal: "#008080", maroon: "#800000",
	silver: "#c0c0c0", pink: "#ffc0cb", indianred: "#cd5c5c", steelblue: "#4682b4",
	darkslategray: "#2f4f4f", darkslategrey: "#2f4f4f", darkolivegreen: "#556b2f",
	darkorange: "#ff8c00", lightslategray: "#778899", midnightblue: "#191970",
};

/**
 * Resolve a vim color value to hex: "#rrggbb", "NONE", a GUI color name,
 * grayN/greyN, or (for cterm) an xterm index or cterm name.
 * Returns "NONE", a hex string, or undefined if unknown.
 */
export function resolveVimColor(value: string, cterm = false): string | undefined {
	const v = value.trim().replace(/^["']|["']$/g, "");
	const lower = v.toLowerCase();
	if (lower === "none") return "NONE";
	if (lower === "fg" || lower === "bg" || lower === "foreground" || lower === "background") return undefined;
	if (parseHex(v)) return `#${v.replace(/^#/, "").toLowerCase()}`;
	if (cterm) {
		if (/^\d+$/.test(v)) return xterm256(Number(v));
		const idx = CTERM_NAMES[lower.replace(/\s+/g, "")];
		return idx === undefined ? undefined : xterm256(idx);
	}
	const gray = /^gr[ae]y(\d{1,3})$/.exec(lower);
	if (gray) {
		const n = Math.round((Math.min(100, Number(gray[1])) * 255) / 100);
		return toHex([n, n, n]);
	}
	return GUI_NAMES[lower.replace(/\s+/g, "")];
}
