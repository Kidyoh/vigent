/**
 * Floating colorscheme picker (`:colorscheme` with no argument).
 *
 * Type to filter, arrows / Ctrl-n / Ctrl-p / Tab to move (each move previews
 * the theme live), Enter to keep it, Esc to go back to the previous theme.
 */
import { type Component, fuzzyFilter, parseKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type Painter, RESET, sgr } from "./theme.js";

/** What the picker shows next to a theme's name: its colors, and dark / light / transparent. */
export interface ThemeLook {
	/** background first, then the accents */
	colors: string[];
	tags: string[];
}

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

export const PICKER_ICONS: Record<"unicode" | "ascii" | "nerd", PickerIcons> = {
	unicode: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤", current: "●", prompt: "❯" },
	nerd: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", lt: "├", rt: "┤", current: "\uf00c", prompt: "\uf002" },
	ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", lt: "+", rt: "+", current: "*", prompt: ">" },
};

const VISIBLE = 14;

/**
 * `:colorscheme`, vim-style with live preview: `j`/`k` (↓/↑, Ctrl-n/p, Tab)
 * move and preview, `g`/`G` jump, Enter keeps it, `q`/Esc puts the old one
 * back. `/` starts a search: type to filter, Esc ends it.
 */
export class ThemePicker implements Component {
	private query = "";
	/** typing goes to the search (after `/`) */
	private searching = false;
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
		private look: (name: string) => ThemeLook | undefined = () => undefined,
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
		if (key === "ctrl+c") return this.onDone(null);
		if (key === "enter" || key === "return") {
			this.onDone(this.filtered()[this.index] ?? null);
			return;
		}
		if (["down", "tab", "ctrl+n", "ctrl+j"].includes(key)) this.move(1);
		else if (["up", "shift+tab", "ctrl+p", "ctrl+k"].includes(key)) this.move(-1);
		else if (this.searching) {
			if (key === "escape") this.searching = false; // the filter stays; j/k move through it
			else if (key === "backspace") {
				if (this.query) {
					this.query = this.query.slice(0, -1);
					this.resetSelection();
				} else this.searching = false;
			} else if (key === "ctrl+u") {
				this.query = "";
				this.resetSelection();
			} else if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
				this.query += data;
				this.resetSelection();
			}
		} else {
			switch (data) {
				case "j":
					this.move(1);
					break;
				case "k":
					this.move(-1);
					break;
				case "g":
					this.move(-this.index);
					break;
				case "G":
					this.move(this.filtered().length - 1 - this.index);
					break;
				case "/":
					this.searching = true;
					break;
				case "q":
					return this.onDone(null);
				default:
					if (key === "escape") {
						if (!this.query) return this.onDone(null);
						this.query = ""; // first Esc drops the filter, the next one closes
						this.resetSelection();
					}
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

	private lookCache = new Map<string, ThemeLook | undefined>();
	private looks(name: string): ThemeLook | undefined {
		if (!this.lookCache.has(name)) this.lookCache.set(name, this.look(name));
		return this.lookCache.get(name);
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
		const keys = this.searching ? "type to filter · Esc done" : "j/k move · Enter pick · q close";
		const count = ` ${items.length === 0 ? 0 : this.index + 1}/${items.length} · ${keys} `;
		const top =
			border(I.tl + I.h) +
			P.on("FloatTitle", bg) +
			title +
			RESET +
			border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr);

		const lines = [top];
		if (this.searching) {
			const prompt = `${I.prompt} ${this.query}`;
			lines.push(
				row(
					P.on("Title", bg) + ` ${I.prompt} ` + RESET + P.on("NormalFloat", bg) + this.query + P.on("PmenuSel", undefined) + " " + RESET,
					visibleWidth(prompt) + 2,
				),
			);
		} else {
			const hint = truncateToWidth(this.query ? `/${this.query}` : "/ to search", Math.max(0, inner - 4), "…");
			lines.push(row(P.on("Comment", bg) + ` ${I.prompt} ${hint}` + RESET, visibleWidth(hint) + 3));
		}
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
			const group = selected ? "PmenuSel" : "NormalFloat";
			const look = this.looks(name);
			// name, then a strip of the theme's own colors, then its tags
			const swatchW = look ? look.colors.length * 2 + 1 : 0;
			const tags = look?.tags.join(" ") ?? "";
			const nameW = Math.max(8, Math.min(24, inner - 2 - swatchW - (tags ? tags.length + 1 : 0)));
			const text = truncateToWidth(`${marker}${name}`, nameW, "…");
			let content = P.on(group, rowBg) + ` ${text}${" ".repeat(Math.max(0, nameW - visibleWidth(text)))} `;
			let used = nameW + 2;
			if (look && inner - used >= swatchW) {
				for (const c of look.colors) content += sgr({ bg: c }, P.colorMode) + "  ";
				content += RESET + P.on(group, rowBg) + " ";
				used += swatchW;
				if (tags && inner - used >= tags.length) {
					content += P.on("Comment", rowBg) + tags;
					used += tags.length;
				}
			}
			lines.push(row(content + RESET, used, rowBg));
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

/** An item in a ChoicePicker. */
export interface PickerChoice {
	value: string;
	note?: string;
}

export interface ChoicePickerOptions {
	/** open with the search already started: typing filters right away */
	search?: boolean;
	/** Backspace on an empty search: the picker was opened by a key, and this takes it back */
	onBackOut?: () => void;
	/** how many choices show at once */
	rows?: number;
}

/**
 * A list to pick from (`:model`, `:effort`), vim-style. `j`/`k` (↓/↑, Ctrl-n/p,
 * Tab) move, `g`/`G` jump to the top/bottom, Enter picks, `q`/Esc closes.
 * `/` starts a search: type to filter, Esc ends it. With `custom`, Enter on a
 * search that matches nothing picks the text itself (a model the list doesn't know).
 */
export class ChoicePicker implements Component {
	private query = "";
	/** typing goes to the search (after `/`) */
	private searching = false;
	private index = 0;
	private scroll = 0;
	private items: PickerChoice[] = [];
	private loading = true;
	private onBackOut?: () => void;
	private rows: number;

	constructor(
		private painter: Painter,
		private icons: PickerIcons,
		private title: string,
		items: PickerChoice[] | Promise<PickerChoice[]>,
		private current: string | undefined,
		private custom: boolean,
		private onDone: (value: string | null) => void,
		private requestRender: () => void,
		opts: ChoicePickerOptions = {},
	) {
		this.searching = opts.search ?? false;
		this.rows = opts.rows ?? VISIBLE;
		this.onBackOut = opts.onBackOut;
		Promise.resolve(items)
			.then((list) => {
				this.items = list;
				this.loading = false;
				this.index = Math.max(0, list.findIndex((c) => c.value === current));
				this.scroll = Math.max(0, this.index - this.rows + 1);
				this.requestRender();
			})
			.catch(() => {
				this.loading = false;
				this.requestRender();
			});
	}

	private filtered(): PickerChoice[] {
		return this.query ? fuzzyFilter(this.items, this.query, (c) => `${c.value} ${c.note ?? ""}`) : this.items;
	}

	handleInput(data: string): void {
		const key = parseKey(data) ?? "";
		const items = this.filtered();
		const move = (by: number) => {
			if (items.length) this.index = (this.index + by + items.length) % items.length;
		};
		if (key === "ctrl+c") return this.onDone(null);
		if (key === "enter" || key === "return") {
			const picked = items[this.index]?.value ?? (this.custom && this.query.trim() ? this.query.trim() : undefined);
			if (picked !== undefined) this.onDone(picked);
			return;
		}
		if (["down", "tab", "ctrl+n", "ctrl+j"].includes(key)) move(1);
		else if (["up", "shift+tab", "ctrl+p", "ctrl+k"].includes(key)) move(-1);
		else if (this.searching) {
			if (key === "escape") this.searching = false; // the filter stays; j/k move through it
			else if (key === "backspace") {
				if (this.query) this.query = this.query.slice(0, -1);
				else if (this.onBackOut) return this.onBackOut();
				else this.searching = false;
				this.index = 0;
			} else if (key === "ctrl+u") {
				this.query = "";
				this.index = 0;
			} else if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
				this.query += data;
				this.index = 0;
			}
		} else {
			switch (data) {
				case "j":
					move(1);
					break;
				case "k":
					move(-1);
					break;
				case "g":
					this.index = 0;
					break;
				case "G":
					this.index = Math.max(0, items.length - 1);
					break;
				case "/":
					this.searching = true;
					break;
				case "q":
					return this.onDone(null);
				default:
					if (key === "escape") {
						if (this.query) {
							this.query = ""; // first Esc drops the filter, the next one closes
							this.index = 0;
						} else return this.onDone(null);
					}
			}
		}
		if (this.index < this.scroll) this.scroll = this.index;
		if (this.index >= this.scroll + this.rows) this.scroll = this.index - this.rows + 1;
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const P = this.painter;
		const I = this.icons;
		const inner = Math.max(20, width) - 2;
		const bg = P.attr("NormalFloat").bg;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const row = (content: string, used: number, rowBg = bg) =>
			border(I.v) + content + P.on("NormalFloat", rowBg) + " ".repeat(Math.max(0, inner - used)) + RESET + border(I.v);
		const items = this.filtered();
		const title = truncateToWidth(` ${this.title} `, Math.max(0, inner - 2), "…");
		const lines = [border(I.tl + I.h) + P.on("FloatTitle", bg) + title + RESET + border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr)];
		if (this.searching) {
			lines.push(row(P.on("Title", bg) + ` ${I.prompt} ` + RESET + P.on("NormalFloat", bg) + this.query + P.on("PmenuSel", undefined) + " " + RESET, visibleWidth(this.query) + 4));
		} else {
			const hint = this.query ? `/${this.query}` : `/ to search${this.custom ? " or type any name" : ""}`;
			const text = truncateToWidth(hint, Math.max(0, inner - 4), "…");
			lines.push(row(P.on("Comment", bg) + ` ${I.prompt} ${text}` + RESET, visibleWidth(text) + 3));
		}
		lines.push(border(I.lt + I.h.repeat(inner) + I.rt));
		const shown = items.slice(this.scroll, this.scroll + this.rows);
		for (let i = 0; i < this.rows; i++) {
			const c = shown[i];
			if (!c) {
				let text = "";
				if (i === 0 && this.loading) text = "  loading…";
				else if (i === 0 && items.length === 0) text = this.custom && this.query.trim() ? `  Enter uses '${this.query.trim()}'` : "  no match";
				lines.push(row(P.on("Comment", bg) + truncateToWidth(text, inner, "…") + RESET, Math.min(inner, visibleWidth(text))));
				continue;
			}
			const selected = this.scroll + i === this.index;
			const rowBg = selected ? (P.attr("PmenuSel").bg ?? P.attr("Visual").bg) : bg;
			const group = selected ? "PmenuSel" : "NormalFloat";
			const marker = c.value === this.current ? `${I.current} ` : "  ";
			const name = truncateToWidth(`${marker}${c.value}`, Math.max(10, inner - 4), "…");
			const note = c.note ? truncateToWidth(`  ${c.note}`, Math.max(0, inner - 2 - visibleWidth(name)), "…") : "";
			lines.push(row(P.on(group, rowBg) + ` ${name}` + P.on("Comment", rowBg) + note + RESET, 1 + visibleWidth(name) + visibleWidth(note), rowBg));
		}
		const keys = this.searching ? "type to filter · Esc done" : "j/k move · Enter pick · q close";
		const count = ` ${items.length ? this.index + 1 : 0}/${items.length} · ${keys} `;
		lines.push(border(I.bl + I.h.repeat(Math.max(0, inner - visibleWidth(count) - 1))) + P.on("Comment", bg) + count + RESET + border(I.h + I.br));
		return lines;
	}
}
