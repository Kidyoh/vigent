/**
 * Split windows over the transcript area, laid out like vim's: a binary tree
 * of side-by-side and stacked splits, with windows at its leaves.
 */

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Win<S> {
	session: S | undefined;
	/** lines from the bottom of the transcript */
	scroll: number;
}

/** "row" is side by side (:vsplit), "column" is stacked (:split). */
export type SplitDir = "row" | "column";
export type Side = "left" | "right" | "up" | "down";

export interface Split<S> {
	dir: SplitDir;
	/** the share of the split's room that `a` gets */
	ratio: number;
	a: Node<S>;
	b: Node<S>;
}

export type Node<S> = Win<S> | Split<S>;

/** A window needs its winbar, a transcript line and the row under it, and room to wrap text. */
export const MIN_WIDTH = 24;
export const MIN_HEIGHT = 4;

export const isSplit = <S>(n: Node<S>): n is Split<S> => "dir" in n;

const minWidth = <S>(n: Node<S>): number => (!isSplit(n) ? MIN_WIDTH : n.dir === "row" ? minWidth(n.a) + minWidth(n.b) + 1 : Math.max(minWidth(n.a), minWidth(n.b)));
const minHeight = <S>(n: Node<S>): number => (!isSplit(n) ? MIN_HEIGHT : n.dir === "column" ? minHeight(n.a) + minHeight(n.b) : Math.max(minHeight(n.a), minHeight(n.b)));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const weight = <S>(n: Node<S>, dir: SplitDir): number => (isSplit(n) && n.dir === dir ? weight(n.a, dir) + weight(n.b, dir) : 1);

export class Windows<S> {
	root: Node<S>;
	cur: Win<S>;
	prev?: Win<S>;

	constructor() {
		this.cur = { session: undefined, scroll: 0 };
		this.root = this.cur;
	}

	all(node: Node<S> = this.root): Win<S>[] {
		return isSplit(node) ? [...this.all(node.a), ...this.all(node.b)] : [node];
	}

	get count(): number {
		return this.all().length;
	}

	/** Whether every window fits. When they don't (a small terminal), only the current one is drawn. */
	fits(area: Rect): boolean {
		return minWidth(this.root) <= area.w && minHeight(this.root) <= area.h;
	}

	/** Every node's place on screen. */
	rects(area: Rect): Map<Node<S>, Rect> {
		const out = new Map<Node<S>, Rect>();
		if (!this.fits(area)) return out.set(this.cur, area);
		const place = (n: Node<S>, r: Rect) => {
			out.set(n, r);
			if (!isSplit(n)) return;
			if (n.dir === "row") {
				const inner = r.w - 1; // the separator
				const a = clamp(Math.round(inner * n.ratio), minWidth(n.a), inner - minWidth(n.b));
				place(n.a, { ...r, w: a });
				place(n.b, { ...r, x: r.x + a + 1, w: inner - a });
			} else {
				const a = clamp(Math.round(r.h * n.ratio), minHeight(n.a), r.h - minHeight(n.b));
				place(n.a, { ...r, h: a });
				place(n.b, { ...r, y: r.y + a, h: r.h - a });
			}
		};
		place(this.root, area);
		return out;
	}

	private parentOf(node: Node<S>, from: Node<S> = this.root): Split<S> | undefined {
		if (!isSplit(from)) return undefined;
		if (from.a === node || from.b === node) return from;
		return this.parentOf(node, from.a) ?? this.parentOf(node, from.b);
	}

	private replace(old: Node<S>, node: Node<S>) {
		const p = this.parentOf(old);
		if (!p) this.root = node;
		else if (p.a === old) p.a = node;
		else p.b = node;
	}

	/** Split the current window; the new one shows the same thing and becomes current. False when there's no room. */
	split(dir: SplitDir, area: Rect): boolean {
		const r = this.rects(area).get(this.cur);
		if (!r || !this.fits(area)) return false;
		if (dir === "row" ? r.w < MIN_WIDTH * 2 + 1 : r.h < MIN_HEIGHT * 2) return false;
		const win: Win<S> = { session: this.cur.session, scroll: this.cur.scroll };
		this.replace(this.cur, { dir, ratio: 0.5, a: this.cur, b: win });
		this.prev = this.cur;
		this.cur = win;
		this.equalize();
		return true;
	}

	/** Close a window. The last one can't be closed. */
	close(win: Win<S>): boolean {
		const p = this.parentOf(win);
		if (!p) return false;
		const sibling = p.a === win ? p.b : p.a;
		this.replace(p, sibling);
		if (this.prev === win) this.prev = undefined;
		if (this.cur === win) {
			this.cur = this.prev && this.all().includes(this.prev) ? this.prev : this.all(sibling)[0];
			this.prev = undefined;
		}
		this.equalize();
		return true;
	}

	only() {
		this.root = this.cur;
		this.prev = undefined;
	}

	equalize(node: Node<S> = this.root) {
		if (!isSplit(node)) return;
		const a = weight(node.a, node.dir);
		node.ratio = a / (a + weight(node.b, node.dir));
		this.equalize(node.a);
		this.equalize(node.b);
	}

	/** The splits around the current window, nearest first, with the side the window is on. */
	private ancestors(dir: SplitDir): { split: Split<S>; inA: boolean }[] {
		const out: { split: Split<S>; inA: boolean }[] = [];
		let node: Node<S> = this.cur;
		for (let p = this.parentOf(node); p; node = p, p = this.parentOf(node)) if (p.dir === dir) out.push({ split: p, inA: p.a === node });
		return out;
	}

	/** Grow (or, with a negative delta, shrink) the current window. */
	resize(dir: SplitDir, delta: number, area: Rect) {
		const near = this.ancestors(dir)[0];
		if (!near) return;
		const rects = this.rects(area);
		const whole = rects.get(near.split);
		const a = rects.get(near.split.a);
		if (!whole || !a) return;
		const size = dir === "row" ? a.w : a.h;
		const room = dir === "row" ? whole.w - 1 : whole.h;
		near.split.ratio = clamp((size + (near.inA ? delta : -delta)) / room, 0, 1);
	}

	/** Give the current window all the room it can have in one direction. */
	maximize(dir: SplitDir) {
		for (const { split, inA } of this.ancestors(dir)) split.ratio = inA ? 1 : 0;
	}

	/** The window next to the current one on a side. */
	neighbour(side: Side, area: Rect): Win<S> | undefined {
		if (!this.fits(area)) return undefined;
		const rects = this.rects(area);
		const r = rects.get(this.cur);
		if (!r) return undefined;
		const across = (o: Rect) => (side === "left" || side === "right" ? o.y < r.y + r.h && r.y < o.y + o.h : o.x < r.x + r.w && r.x < o.x + o.w);
		const touches = (o: Rect) => {
			if (side === "left") return o.x + o.w + 1 === r.x;
			if (side === "right") return r.x + r.w + 1 === o.x;
			return side === "up" ? o.y + o.h === r.y : r.y + r.h === o.y;
		};
		const found = this.all().filter((w) => {
			const o = rects.get(w);
			return w !== this.cur && o && touches(o) && across(o);
		});
		return found.find((w) => w === this.prev) ?? found[0];
	}

	/** The window sharing the current one's split, when it's a single window. */
	sibling(): Win<S> | undefined {
		const p = this.parentOf(this.cur);
		const other = p && (p.a === this.cur ? p.b : p.a);
		return other && !isSplit(other) ? other : undefined;
	}

	/** Swap the two halves of the current window's split; the current window moves with its half. */
	rotate() {
		const p = this.parentOf(this.cur);
		if (!p) return;
		[p.a, p.b] = [p.b, p.a];
		p.ratio = 1 - p.ratio;
	}
}
