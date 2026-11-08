/**
 * The `:review` window: the agent's changes hunk by hunk.
 *
 *   j/k ]c/[c  next / previous hunk      J/K  next / previous file
 *   x  drop the hunk (take it out of the worktree)
 *   X  drop the whole file               u  undo the last drop
 *   q / Esc  close
 */
import { type Component, truncateToWidth, visibleWidth } from "./tui.js";
import type { FileDiff, Hunk } from "./hunks.js";
import { patchFor } from "./hunks.js";
import { keyFromInput } from "./keys.js";
import type { PickerIcons } from "./picker.js";
import { type Painter, RESET } from "./theme.js";

export interface ReviewHost {
	/** take a patch out of the worktree; resolves with the new diff, or rejects with git's reason */
	drop(patch: string): Promise<FileDiff[]>;
	/** put a dropped patch back */
	restore(patch: string): Promise<FileDiff[]>;
	close(): void;
	requestRender(): void;
}

interface Row {
	text: string;
	group: string;
	/** index into this.flat of the hunk this row belongs to (-1 for file headers) */
	hunk: number;
	header?: boolean;
}

export class HunkReview implements Component {
	private flat: { file: FileDiff; hunk: Hunk; fileIdx: number }[] = [];
	private index = 0;
	private top = 0;
	private undo: { patch: string; label: string }[] = [];
	private dropped = 0;
	private message = "";
	private busy = false;

	constructor(
		private painter: Painter,
		private icons: PickerIcons,
		private title: string,
		private files: FileDiff[],
		private height: () => number,
		private host: ReviewHost,
	) {
		this.flatten();
	}

	private flatten() {
		this.flat = this.files.flatMap((file, fileIdx) => file.hunks.map((hunk) => ({ file, hunk, fileIdx })));
		this.index = Math.min(this.index, Math.max(0, this.flat.length - 1));
	}

	private rows(width: number): Row[] {
		const out: Row[] = [];
		this.files.forEach((file, fi) => {
			const n = file.hunks.length;
			out.push({ text: `${file.path}  ${file.binary ? "(binary: X drops it)" : `${n} hunk${n === 1 ? "" : "s"}`}`, group: "Title", hunk: -1, header: true });
			for (const hunk of file.hunks) {
				const idx = this.flat.findIndex((h) => h.hunk === hunk && h.fileIdx === fi);
				out.push({ text: hunk.header, group: "Special", hunk: idx, header: true });
				for (const l of hunk.lines) {
					out.push({
						text: truncateToWidth(l.replace(/\t/g, "  "), width, "…"),
						group: l.startsWith("+") ? "Added" : l.startsWith("-") ? "Removed" : l.startsWith("\\") ? "Comment" : "NormalFloat",
						hunk: idx,
					});
				}
			}
		});
		return out;
	}

	handleInput(data: string): void {
		const key = keyFromInput(data);
		if (this.busy) return;
		switch (key) {
			case "q":
			case "<Esc>":
			case "<C-c>":
				this.host.close();
				return;
			case "j":
			case "n":
			case "<Down>":
			case "<Tab>":
				this.move(1);
				break;
			case "k":
			case "N":
			case "<Up>":
			case "<S-Tab>":
				this.move(-1);
				break;
			case "]":
			case "[":
				this.pendingBracket = key;
				return;
			case "c":
				if (this.pendingBracket) this.move(this.pendingBracket === "]" ? 1 : -1);
				break;
			case "J":
				this.moveFile(1);
				break;
			case "K":
				this.moveFile(-1);
				break;
			case "g":
				this.index = 0;
				break;
			case "G":
				this.index = Math.max(0, this.flat.length - 1);
				break;
			case "x":
				this.dropHunk();
				return;
			case "X":
				this.dropFile();
				return;
			case "u":
				this.undoLast();
				return;
		}
		this.pendingBracket = undefined;
		this.host.requestRender();
	}

	private pendingBracket?: string;

	private move(d: number) {
		if (this.flat.length === 0) return;
		this.index = Math.max(0, Math.min(this.flat.length - 1, this.index + d));
	}

	private moveFile(d: number) {
		const cur = this.flat[this.index]?.fileIdx ?? 0;
		const target = d > 0 ? this.flat.findIndex((h) => h.fileIdx > cur) : this.flat.findIndex((h) => h.fileIdx === Math.max(0, cur - 1));
		if (target >= 0) this.index = target;
	}

	private run(patch: string, label: string, action: "drop" | "restore") {
		this.busy = true;
		this.message = action === "drop" ? "dropping…" : "restoring…";
		this.host.requestRender();
		(action === "drop" ? this.host.drop(patch) : this.host.restore(patch))
			.then((files) => {
				if (action === "drop") {
					this.undo.push({ patch, label });
					this.dropped++;
					this.message = `dropped ${label} · u undoes`;
				} else {
					this.dropped--;
					this.message = `restored ${label}`;
				}
				this.files = files;
				this.flatten();
			})
			.catch((err) => {
				this.message = `git couldn't ${action === "drop" ? "drop" : "restore"} ${label}: ${(err as Error).message}`;
			})
			.finally(() => {
				this.busy = false;
				this.host.requestRender();
			});
	}

	private dropHunk() {
		const cur = this.flat[this.index];
		if (!cur) return;
		const n = cur.file.hunks.indexOf(cur.hunk) + 1;
		this.run(patchFor(cur.file, [cur.hunk]), `hunk ${n} of ${cur.file.path}`, "drop");
	}

	private dropFile() {
		const cur = this.flat[this.index];
		const file = cur?.file ?? this.files[0];
		if (!file) return;
		if (file.binary && file.hunks.length === 0) {
			this.message = "binary files can't be dropped here yet";
			this.host.requestRender();
			return;
		}
		this.run(patchFor(file), file.path, "drop");
	}

	private undoLast() {
		const last = this.undo.pop();
		if (!last) {
			this.message = "nothing to undo";
			this.host.requestRender();
			return;
		}
		this.run(last.patch, last.label, "restore");
	}

	invalidate(): void {}

	render(width: number): string[] {
		const P = this.painter;
		const I = this.icons;
		const inner = Math.max(30, width) - 2;
		const bg = P.attr("NormalFloat").bg;
		const sel = P.attr("PmenuSel").bg ?? P.attr("Visual").bg;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const row = (content: string, used: number, rowBg = bg) =>
			border(I.v) + content + P.on("NormalFloat", rowBg) + " ".repeat(Math.max(0, inner - used)) + RESET + border(I.v);

		const total = this.flat.length;
		const title = ` ${this.title} · ${total} hunk${total === 1 ? "" : "s"} left${this.dropped ? ` · ${this.dropped} dropped` : ""} `;
		const lines = [border(I.tl + I.h) + P.on("FloatTitle", bg) + truncateToWidth(title, inner - 2, "…") + RESET + border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(truncateToWidth(title, inner - 2, "…")))) + I.tr)];

		const body = Math.max(3, this.height() - 4);
		const rows = this.rows(inner - 3);
		if (total === 0) {
			rows.length = 0;
			rows.push({ text: this.dropped ? "every change is dropped: nothing would be merged (u undoes)" : "no changes", group: "Comment", hunk: -1 });
		}
		// keep the selected hunk's header in view, a little below the top
		const at = rows.findIndex((r) => r.hunk === this.index && r.header);
		if (at >= 0 && (at < this.top || at >= this.top + body - 3)) this.top = Math.max(0, at - 2);
		this.top = Math.min(this.top, Math.max(0, rows.length - body));
		for (const r of rows.slice(this.top, this.top + body)) {
			const on = r.hunk === this.index && total > 0;
			const rowBg = on && r.header ? sel : bg;
			const bar = on ? P.on("Title", rowBg) + "▌ " : P.on("NormalFloat", rowBg) + "  ";
			const text = truncateToWidth(r.text, inner - 3, "…");
			lines.push(row(bar + P.on(on && r.header ? "PmenuSel" : r.group, rowBg) + text, 2 + visibleWidth(text), rowBg));
		}
		while (lines.length < body + 1) lines.push(row("", 0));
		const msg = this.message || "x drop hunk · X drop file · u undo · j/k hunks · J/K files · q close · :merge takes what's left";
		lines.push(border(I.lt + I.h.repeat(inner) + I.rt));
		lines.push(row(P.on(this.message ? "ModeMsg" : "Comment", bg) + ` ${truncateToWidth(msg, inner - 2, "…")}`, Math.min(inner, visibleWidth(msg) + 1)));
		lines.push(border(I.bl + I.h.repeat(inner) + I.br));
		return lines;
	}
}
