/**
 * A scrollable floating window: read-only text (`:help`, `:map`, `:diff`),
 * optionally with selectable rows (`:dash`) and jump points (`]c` / `[c`
 * between diff hunks).
 */
import { type Component, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { PickerIcons } from "./picker.js";
import { type Painter, RESET } from "./theme.js";

/** One line: a list of [highlight group, text] segments. */
export type FloatLine = [string, string][];

export interface FloatOptions {
	/** line indices that can be selected with j/k */
	selectable?: number[];
	/** Enter on a selectable line */
	onSelect?: (lineIdx: number) => void;
	/** selectable line to start on */
	initial?: number;
	/** line indices `]c` / `[c` jump between */
	jumps?: number[];
}

export class TextFloat implements Component {
	private top = 0;
	private selected = 0;
	private pending = "";

	constructor(
		private painter: Painter,
		private icons: PickerIcons,
		private title: string,
		private lines: FloatLine[],
		private height: () => number,
		private onClose: () => void,
		private requestRender: () => void,
		private opts: FloatOptions = {},
	) {
		const sel = opts.selectable ?? [];
		if (sel.length > 0) {
			this.selected = Math.max(0, opts.initial !== undefined ? sel.indexOf(opts.initial) : 0);
			this.reveal(sel[this.selected]);
		}
	}

	private reveal(line: number) {
		const n = this.visible();
		if (line < this.top) this.top = line;
		else if (line >= this.top + n) this.top = Math.min(Math.max(0, this.lines.length - n), line - n + 2);
	}

	private select(delta: number) {
		const sel = this.opts.selectable ?? [];
		if (sel.length === 0) return false;
		this.selected = Math.max(0, Math.min(sel.length - 1, this.selected + delta));
		this.reveal(sel[this.selected]);
		return true;
	}

	private jump(dir: 1 | -1) {
		const jumps = this.opts.jumps ?? [];
		const target = dir > 0 ? jumps.find((j) => j > this.top) : [...jumps].reverse().find((j) => j < this.top);
		if (target !== undefined) this.top = Math.min(target, Math.max(0, this.lines.length - this.visible()));
	}

	private visible(): number {
		return Math.max(3, Math.min(this.lines.length, this.height() - 2));
	}

	private scroll(delta: number) {
		const max = Math.max(0, this.lines.length - this.visible());
		this.top = Math.max(0, Math.min(max, this.top + delta));
	}

	handleInput(data: string): void {
		const key = parseKey(data) ?? data;
		if (this.pending) {
			const p = this.pending;
			this.pending = "";
			if ((p === "]" || p === "[") && key === "c") this.jump(p === "]" ? 1 : -1);
			this.requestRender();
			return;
		}
		switch (key) {
			case "enter":
			case "return": {
				const sel = this.opts.selectable ?? [];
				this.onClose();
				if (sel.length > 0) this.opts.onSelect?.(sel[this.selected]);
				return;
			}
			case "escape":
			case "q":
			case "ctrl+c":
				this.onClose();
				return;
			case "]":
			case "[":
				this.pending = key;
				return;
			case "j":
			case "down":
				if (!this.select(1)) this.scroll(1);
				break;
			case "k":
			case "up":
				if (!this.select(-1)) this.scroll(-1);
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
		const selectedLine = (this.opts.selectable ?? [])[this.selected];
		const selBg = P.attr("PmenuSel").bg ?? P.attr("Visual").bg;
		this.lines.slice(this.top, this.top + n).forEach((line, i) => {
			const isSelected = this.top + i === selectedLine;
			const rowBg = isSelected ? selBg : bg;
			let text = "";
			let used = 0;
			for (const [group, seg] of line) {
				const t = truncateToWidth(seg, Math.max(0, inner - 1 - used), "…");
				// the selected row uses the theme's PmenuSel colors so it stays readable
				text += RESET + P.on(isSelected ? "PmenuSel" : group, rowBg) + t;
				used += visibleWidth(t);
			}
			out.push(
				border(I.v) +
					P.on("NormalFloat", rowBg) +
					" " +
					text +
					P.on("NormalFloat", rowBg) +
					" ".repeat(Math.max(0, inner - 1 - used)) +
					RESET +
					border(I.v),
			);
		});
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
