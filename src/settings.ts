/**
 * `:settings`: every option in one float, changed in place.
 *
 *   j/k move · Enter or Space change · h/l step back or forward ·
 *   w save to config.toml · q / Esc close
 *
 * Changes apply at once. A key row waits for the new keys: type them, then
 * Enter (Esc cancels).
 */
import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { keyFromInput } from "./keys.js";
import type { PickerIcons } from "./picker.js";
import { type Painter, RESET } from "./theme.js";

export interface SettingItem {
	section: string;
	label: string;
	/** what it is now, shown at the right */
	value: () => string;
	/** h/l, Enter or Space: step the value (1 forward, -1 back) */
	change?: (dir: 1 | -1) => void;
	/** Enter opens something else instead (the theme picker) */
	open?: () => void;
	/** Enter waits for keys, then calls this with them (vim notation, e.g. ["<Space>", "x"]) */
	bind?: (keys: string[]) => string | undefined;
	/** shown under the list when the row is selected */
	hint?: string;
}

export class SettingsFloat implements Component {
	private index = 0;
	private scroll = 0;
	private capturing?: string[];
	private message = "";

	constructor(
		private painter: Painter,
		private icons: PickerIcons,
		private items: SettingItem[],
		private height: () => number,
		private onClose: () => void,
		private onSave: () => string,
		private requestRender: () => void,
	) {}

	/** rows: section headers and items, in order */
	private rows(): ({ header: string } | { item: SettingItem; i: number })[] {
		const out: ({ header: string } | { item: SettingItem; i: number })[] = [];
		let section = "";
		this.items.forEach((item, i) => {
			if (item.section !== section) {
				section = item.section;
				out.push({ header: section });
			}
			out.push({ item, i });
		});
		return out;
	}

	handleInput(data: string): void {
		const key = keyFromInput(data);
		if (this.capturing) {
			if (key === "<Esc>") {
				this.capturing = undefined;
				this.message = "cancelled";
			} else if (key === "<CR>") {
				const keys = this.capturing;
				this.capturing = undefined;
				if (keys.length === 0) this.message = "no keys typed";
				else this.message = this.items[this.index].bind?.(keys) ?? "";
			} else if (key === "<BS>") {
				this.capturing.pop();
			} else if (key) {
				this.capturing.push(key);
			}
			this.requestRender();
			return;
		}
		const item = this.items[this.index];
		switch (key) {
			case "q":
			case "<Esc>":
			case "<C-c>":
				this.onClose();
				return;
			case "j":
			case "<Down>":
			case "<Tab>":
			case "<C-n>":
				this.move(1);
				break;
			case "k":
			case "<Up>":
			case "<S-Tab>":
			case "<C-p>":
				this.move(-1);
				break;
			case "g":
				this.index = 0;
				break;
			case "G":
				this.index = this.items.length - 1;
				break;
			case "l":
			case "<Right>":
				item.change?.(1);
				this.message = "";
				break;
			case "h":
			case "<Left>":
				item.change?.(-1);
				this.message = "";
				break;
			case "<CR>":
			case "<Space>":
				this.message = "";
				if (item.open) {
					item.open();
					return;
				}
				if (item.bind) {
					this.capturing = [];
					break;
				}
				item.change?.(1);
				break;
			case "w":
				this.message = this.onSave();
				break;
		}
		this.requestRender();
	}

	private move(delta: number) {
		this.index = (this.index + delta + this.items.length) % this.items.length;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const P = this.painter;
		const I = this.icons;
		const inner = Math.max(30, width) - 2;
		const bg = P.attr("NormalFloat").bg;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const row = (content: string, used: number, rowBg = bg) =>
			border(I.v) + content + P.on("NormalFloat", rowBg) + " ".repeat(Math.max(0, inner - used)) + RESET + border(I.v);

		const title = " Settings ";
		const lines = [border(I.tl + I.h) + P.on("FloatTitle", bg) + title + RESET + border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr)];

		const rows = this.rows();
		const selectedRow = rows.findIndex((r) => "item" in r && r.i === this.index);
		const room = Math.max(5, this.height() - 6);
		if (selectedRow < this.scroll) this.scroll = Math.max(0, selectedRow - 1);
		if (selectedRow >= this.scroll + room) this.scroll = selectedRow - room + 1;
		for (const r of rows.slice(this.scroll, this.scroll + room)) {
			if ("header" in r) {
				lines.push(row(P.on("Title", bg) + ` ${r.header}` + RESET, r.header.length + 1));
				continue;
			}
			const selected = r.i === this.index;
			const rowBg = selected ? (P.attr("PmenuSel").bg ?? P.attr("Visual").bg) : bg;
			const group = selected ? "PmenuSel" : "NormalFloat";
			const value =
				selected && this.capturing
					? `${this.capturing.join("") || "…"}  (Enter keeps, Esc cancels)`
					: r.item.value();
			const labelW = Math.min(34, inner - 4);
			const label = truncateToWidth(r.item.label, labelW, "…");
			const valueText = truncateToWidth(value, Math.max(4, inner - labelW - 5), "…");
			const arrows = r.item.change && !r.item.bind ? "‹ › " : "";
			lines.push(
				row(
					P.on(group, rowBg) + `   ${label}${" ".repeat(Math.max(0, labelW - visibleWidth(label)))} ` + P.on(selected ? "PmenuSel" : "Special", rowBg) + valueText + P.on("Comment", rowBg) + (selected ? ` ${arrows}` : ""),
					3 + labelW + 1 + visibleWidth(valueText) + (selected ? 1 + arrows.length : 0),
					rowBg,
				),
			);
		}
		while (lines.length < room + 1) lines.push(row("", 0));

		const item = this.items[this.index];
		const hint = this.capturing
			? "type the new keys, then Enter · Backspace removes one · Esc cancels"
			: this.message || item.hint || "";
		lines.push(border(I.lt + I.h.repeat(inner) + I.rt));
		lines.push(row(P.on(this.message && !this.capturing ? "ModeMsg" : "Comment", bg) + ` ${truncateToWidth(hint, inner - 2, "…")}` + RESET, Math.min(inner, hint.length + 1)));
		const keys = " j/k move · Enter/Space change · h/l back/forward · w save to config.toml · q close ";
		lines.push(border(I.bl) + P.on("Comment", bg) + truncateToWidth(keys, inner, "") + RESET + border(I.h.repeat(Math.max(0, inner - visibleWidth(truncateToWidth(keys, inner, "")))) + I.br));
		return lines;
	}
}
