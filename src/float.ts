/** A scrollable floating window for read-only text (`:help`, `:map`). */
import { type Component, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { PickerIcons } from "./picker.js";
import { type Painter, RESET } from "./theme.js";

/** One line: a list of [highlight group, text] segments. */
export type FloatLine = [string, string][];

export class TextFloat implements Component {
	private top = 0;

	constructor(
		private painter: Painter,
		private icons: PickerIcons,
		private title: string,
		private lines: FloatLine[],
		private height: () => number,
		private onClose: () => void,
		private requestRender: () => void,
	) {}

	private visible(): number {
		return Math.max(3, Math.min(this.lines.length, this.height() - 2));
	}

	private scroll(delta: number) {
		const max = Math.max(0, this.lines.length - this.visible());
		this.top = Math.max(0, Math.min(max, this.top + delta));
	}

	handleInput(data: string): void {
		const key = parseKey(data) ?? data;
		switch (key) {
			case "escape":
			case "q":
			case "enter":
			case "return":
			case "ctrl+c":
				this.onClose();
				return;
			case "j":
			case "down":
				this.scroll(1);
				break;
			case "k":
			case "up":
				this.scroll(-1);
				break;
			case "ctrl+d":
			case "pageDown":
			case "space":
				this.scroll(Math.floor(this.visible() / 2));
				break;
			case "ctrl+u":
			case "pageUp":
				this.scroll(-Math.floor(this.visible() / 2));
				break;
			case "g":
				this.top = 0;
				break;
			case "G":
			case "shift+g":
				this.scroll(this.lines.length);
				break;
		}
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const P = this.painter;
		const I = this.icons;
		const inner = Math.max(10, width - 2);
		const bg = P.attr("NormalFloat").bg;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const title = ` ${this.title} `;
		const out = [
			border(I.tl + I.h) +
				P.on("FloatTitle", bg) +
				title +
				RESET +
				border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr),
		];
		const n = this.visible();
		for (const line of this.lines.slice(this.top, this.top + n)) {
			let text = "";
			let used = 0;
			for (const [group, seg] of line) {
				const t = truncateToWidth(seg, Math.max(0, inner - 1 - used), "…");
				text += RESET + P.on(group, bg) + t;
				used += visibleWidth(t);
			}
			out.push(border(I.v) + P.on("NormalFloat", bg) + " " + text + P.on("NormalFloat", bg) + " ".repeat(Math.max(0, inner - 1 - used)) + RESET + border(I.v));
		}
		const more = this.lines.length > n ? ` ${this.top + 1}-${Math.min(this.lines.length, this.top + n)}/${this.lines.length} ` : "";
		const hint = " q close ";
		out.push(
			border(I.bl + I.h) +
				P.on("Comment", bg) +
				hint +
				RESET +
				border(I.h.repeat(Math.max(0, inner - 2 - visibleWidth(hint) - visibleWidth(more)))) +
				P.on("Comment", bg) +
				more +
				RESET +
				border(I.h + I.br),
		);
		return out;
	}
}
