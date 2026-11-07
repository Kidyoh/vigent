/**
 * Floating colorscheme picker (`:colorscheme` with no argument).
 *
 * Type to filter, arrows / Ctrl-n / Ctrl-p / Tab to move (each move previews
 * the theme live), Enter to keep it, Esc to go back to the previous theme.
 */
import { type Component, fuzzyFilter, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type Painter, RESET } from "./theme.js";

export interface PickerIcons {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
	lt: string;
	rt: string;
	current: string;
	prompt: string;
}

export const PICKER_ICONS: Record<"unicode" | "ascii", PickerIcons> = {
	unicode: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤", current: "●", prompt: "❯" },
	ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", lt: "+", rt: "+", current: "*", prompt: ">" },
};

const VISIBLE = 10;

export class ThemePicker implements Component {
	private query = "";
	private index = 0;
	private scroll = 0;

	constructor(
		private painter: Painter,
		private themes: string[],
		private current: string,
		private icons: PickerIcons,
		private onPreview: (name: string) => void,
		private onDone: (name: string | null) => void,
		private requestRender: () => void,
	) {
		this.index = Math.max(0, themes.indexOf(current));
		this.scroll = Math.max(0, this.index - VISIBLE + 1);
	}

	private filtered(): string[] {
		return this.query ? fuzzyFilter(this.themes, this.query, (t) => t) : this.themes;
	}

	private move(delta: number) {
		const items = this.filtered();
		if (items.length === 0) return;
		this.index = (this.index + delta + items.length) % items.length;
		if (this.index < this.scroll) this.scroll = this.index;
		if (this.index >= this.scroll + VISIBLE) this.scroll = this.index - VISIBLE + 1;
		this.onPreview(items[this.index]);
	}

	handleInput(data: string): void {
		const key = parseKey(data) ?? "";
		switch (key) {
			case "escape":
			case "ctrl+c":
				this.onDone(null);
				return;
			case "enter":
			case "return": {
				const items = this.filtered();
				this.onDone(items[this.index] ?? null);
				return;
			}
			case "down":
			case "tab":
			case "ctrl+n":
			case "ctrl+j":
				this.move(1);
				break;
			case "up":
			case "shift+tab":
			case "ctrl+p":
			case "ctrl+k":
				this.move(-1);
				break;
			case "backspace":
				this.query = this.query.slice(0, -1);
				this.resetSelection();
				break;
			case "ctrl+u":
				this.query = "";
				this.resetSelection();
				break;
			default:
				if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
					this.query += data;
					this.resetSelection();
				}
		}
		this.requestRender();
	}

	private resetSelection() {
		this.index = 0;
		this.scroll = 0;
		const first = this.filtered()[0];
		if (first) this.onPreview(first);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const P = this.painter;
		const I = this.icons;
		const w = Math.max(20, width);
		const inner = w - 2;
		const bg = P.attr("NormalFloat").bg;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const row = (content: string, plainWidth: number, rowBg = bg) =>
			border(I.v) +
			content +
			P.on("NormalFloat", rowBg) +
			" ".repeat(Math.max(0, inner - plainWidth)) +
			RESET +
			border(I.v);

		const items = this.filtered();
		const title = " Colorschemes ";
		const count = ` ${items.length === 0 ? 0 : this.index + 1}/${items.length} `;
		const top =
			border(I.tl + I.h) +
			P.on("FloatTitle", bg) +
			title +
			RESET +
			border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr);

		const lines = [top];
		const prompt = `${I.prompt} ${this.query}`;
		lines.push(
			row(
				P.on("Title", bg) + ` ${I.prompt} ` + RESET + P.on("NormalFloat", bg) + this.query + P.on("PmenuSel", undefined) + " " + RESET,
				visibleWidth(prompt) + 2,
			),
		);
		lines.push(border(I.lt + I.h.repeat(inner) + I.rt));

		const shown = items.slice(this.scroll, this.scroll + VISIBLE);
		for (let i = 0; i < VISIBLE; i++) {
			const name = shown[i];
			if (name === undefined) {
				lines.push(row("", 0));
				continue;
			}
			const selected = this.scroll + i === this.index;
			const rowBg = selected ? (P.attr("PmenuSel").bg ?? P.attr("Visual").bg) : bg;
			const marker = name === this.current ? `${I.current} ` : "  ";
			const text = truncateToWidth(`${marker}${name}`, inner - 2, "…");
			const group = selected ? "PmenuSel" : "NormalFloat";
			lines.push(row(P.on(group, rowBg) + ` ${text} ` + RESET, visibleWidth(text) + 2, rowBg));
		}
		if (items.length === 0) lines[3] = row(P.on("Comment", bg) + "  no match" + RESET, 10);

		lines.push(
			border(I.bl + I.h.repeat(Math.max(0, inner - visibleWidth(count) - 1))) +
				P.on("Comment", bg) +
				count +
				RESET +
				border(I.h + I.br),
		);
		return lines;
	}
}
