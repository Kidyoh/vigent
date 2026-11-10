/**
 * Vim's normal mode for one line of text: the prompt or the command line.
 * Motions, operators, text objects, counts, undo and `.`, with no terminal or
 * app state, so every command is a plain test.
 */

export type LineExit = "insert" | "back" | "submit";

export interface LineResult {
	/** leave normal mode: back to typing, back where it was opened from, or send the line */
	exit?: LineExit;
	/** j / k: show the next (1) or previous (-1) line from history */
	history?: 1 | -1;
	yanked?: string;
}

type Operator = "d" | "c" | "y";
type Wait = { kind: "find"; cmd: string } | { kind: "replace" } | { kind: "object"; around: boolean } | { kind: "g" } | { kind: "register" };

const MAX_COUNT = 9999;

function charClass(c: string, big: boolean): number {
	if (/\s/.test(c)) return 0;
	if (big) return 1;
	return /[\p{L}\p{N}_]/u.test(c) ? 1 : 2;
}

/** w: the start of the next word. */
export function wordForward(chars: string[], from: number, big = false): number {
	let i = from;
	if (i >= chars.length) return chars.length;
	const c = charClass(chars[i], big);
	if (c !== 0) while (i < chars.length && charClass(chars[i], big) === c) i++;
	while (i < chars.length && charClass(chars[i], big) === 0) i++;
	return i;
}

/** b: the start of this word, or the one before. */
export function wordBack(chars: string[], from: number, big = false): number {
	let i = from - 1;
	while (i > 0 && charClass(chars[i], big) === 0) i--;
	if (i <= 0) return 0;
	const c = charClass(chars[i], big);
	while (i > 0 && charClass(chars[i - 1], big) === c) i--;
	return i;
}

function wordEnd(chars: string[], from: number, big: boolean): number {
	let i = from + 1;
	while (i < chars.length && charClass(chars[i], big) === 0) i++;
	if (i >= chars.length) return Math.max(0, chars.length - 1);
	const c = charClass(chars[i], big);
	while (i + 1 < chars.length && charClass(chars[i + 1], big) === c) i++;
	return i;
}

function wordEndBack(chars: string[], from: number, big: boolean): number {
	if (from <= 0) return 0;
	let i = from;
	const c = charClass(chars[i] ?? " ", big);
	if (c !== 0) while (i >= 0 && charClass(chars[i], big) === c) i--;
	while (i >= 0 && charClass(chars[i], big) === 0) i--;
	return Math.max(0, i);
}

const PAIRS: Record<string, [string, string]> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
	"<": ["<", ">"],
	">": ["<", ">"],
};

export class LineEditor {
	chars: string[] = [];
	pos = 0;
	/** what p pastes; the last delete or yank */
	register = "";
	private undoStack: { text: string; pos: number }[] = [];
	private redoStack: { text: string; pos: number }[] = [];
	private count = 0;
	private opCount = 0;
	private op?: Operator;
	private wait?: Wait;
	private typed: string[] = [];
	private lastChange?: string[];
	private lastFind?: { cmd: string; ch: string };
	private changedNow = false;
	private replaying = false;
	/** a c, s or C left for typing; the typing joins its undo step */
	private changeOpen = false;

	get text(): string {
		return this.chars.join("");
	}

	/** Keys typed so far for a command that isn't finished (`d2`), for showcmd. */
	get pendingKeys(): string {
		return this.pending ? this.typed.join("") : "";
	}

	/** Take the line as it is now; what happened to it since (typing, say) becomes one undo step. */
	sync(text: string, pos: number) {
		if (text !== this.text) {
			// what was typed after c, s or C is part of that change, one undo step with it
			if (!this.changeOpen) this.undoStack.push({ text: this.text, pos: this.pos });
			this.redoStack = [];
			this.chars = [...text];
		}
		this.changeOpen = false;
		this.pos = pos;
		this.clamp();
	}

	private get pending(): boolean {
		return Boolean(this.wait || this.op || this.count);
	}

	private clamp() {
		this.pos = Math.max(0, Math.min(this.pos, this.chars.length - 1));
	}

	private clearPending() {
		this.count = 0;
		this.opCount = 0;
		this.op = undefined;
		this.wait = undefined;
	}

	private times(): number {
		return Math.min(MAX_COUNT, Math.max(1, this.opCount) * Math.max(1, this.count));
	}

	/** One key, in vigent's notation ("w", "<Esc>", "<C-r>"). */
	feed(token: string): LineResult {
		this.typed.push(token);
		const key = token === "<lt>" ? "<" : token === "<Space>" ? " " : token;
		const result = this.step(key);
		if (!this.pending) {
			if (this.changedNow && !result.exit && !this.replaying) this.lastChange = this.typed;
			this.typed = [];
			this.changedNow = false;
		}
		if (!result.exit) this.clamp();
		return result;
	}

	private step(key: string): LineResult {
		if (this.wait) {
			const w = this.wait;
			this.wait = undefined;
			return this.afterWait(w, key);
		}
		if (key === "<Esc>" || key === "<C-c>") {
			const busy = this.pending;
			this.clearPending();
			return busy ? {} : { exit: "back" };
		}
		if (/^[1-9]$/.test(key) || (key === "0" && this.count > 0)) {
			this.count = Math.min(MAX_COUNT, this.count * 10 + Number(key));
			return {};
		}
		if (key === '"') {
			this.wait = { kind: "register" }; // one register: vigent's, whichever name is typed
			return {};
		}
		return this.op ? this.operatorPending(key) : this.command(key);
	}

	private operatorPending(key: string): LineResult {
		const op = this.op as Operator;
		if (key === op) return this.apply(0, this.chars.length);
		if (key === "i" || key === "a") {
			this.wait = { kind: "object", around: key === "a" };
			return {};
		}
		// vim: cw on a word stops at its end
		if (op === "c" && (key === "w" || key === "W") && this.chars[this.pos] && charClass(this.chars[this.pos], false) !== 0) {
			return this.motion(key === "w" ? "e" : "E");
		}
		return this.motion(key);
	}

	private command(key: string): LineResult {
		const n = this.times();
		const len = this.chars.length;
		switch (key) {
			case "d":
			case "c":
			case "y":
				this.op = key;
				this.opCount = this.count;
				this.count = 0;
				return {};
			case "x":
			case "<Del>":
				this.op = "d";
				return this.apply(this.pos, Math.min(len, this.pos + n));
			case "X":
				this.op = "d";
				return this.apply(Math.max(0, this.pos - n), this.pos);
			case "s":
				this.op = "c";
				return this.apply(this.pos, Math.min(len, this.pos + n));
			case "S":
				this.op = "c";
				return this.apply(0, len);
			case "D":
				this.op = "d";
				return this.apply(this.pos, len);
			case "C":
				this.op = "c";
				return this.apply(this.pos, len);
			case "Y":
				this.op = "y";
				return this.apply(this.pos, len);
			case "r":
				this.wait = { kind: "replace" };
				return {};
			case "~":
				return this.toggleCase(n);
			case "p":
			case "P":
				return this.put(key === "p", n);
			case "J":
				return this.join();
			case "u":
				return this.history(this.undoStack, this.redoStack);
			case "<C-r>":
				return this.history(this.redoStack, this.undoStack);
			case ".":
				return this.repeat();
			case "i":
				this.clearPending();
				return { exit: "insert" };
			case "a":
				this.clearPending();
				this.pos = Math.min(len, this.pos + 1);
				return { exit: "insert" };
			case "I":
				this.clearPending();
				this.pos = this.firstNonBlank();
				return { exit: "insert" };
			case "A":
				this.clearPending();
				this.pos = len;
				return { exit: "insert" };
			case "<CR>":
				this.clearPending();
				return { exit: "submit" };
			case "j":
			case "<Down>":
			case "<C-n>":
				this.clearPending();
				return { history: 1 };
			case "k":
			case "<Up>":
			case "<C-p>":
				this.clearPending();
				return { history: -1 };
		}
		return this.motion(key);
	}

	private firstNonBlank(): number {
		const i = this.chars.findIndex((c) => !/\s/.test(c));
		return i < 0 ? 0 : i;
	}

	private repeatWord(step: (at: number) => number, n: number): number {
		let at = this.pos;
		for (let i = 0; i < n; i++) at = step(at);
		return at;
	}

	private motion(key: string): LineResult {
		const n = this.times();
		const last = Math.max(0, this.chars.length - 1);
		const big = key === key.toUpperCase();
		switch (key) {
			case "h":
			case "<Left>":
			case "<BS>":
				return this.go(Math.max(0, this.pos - n), false);
			case "l":
			case "<Right>":
			case " ":
				return this.go(Math.min(this.chars.length, this.pos + n), false);
			case "0":
			case "<Home>":
				return this.go(0, false);
			case "^":
				return this.go(this.firstNonBlank(), false);
			case "$":
			case "<End>":
			case "G":
				return this.go(last, true);
			case "|":
				return this.go(Math.min(last, n - 1), false);
			case "w":
			case "W":
				return this.go(this.repeatWord((at) => wordForward(this.chars, at, big), n), false);
			case "b":
			case "B":
				return this.go(this.repeatWord((at) => wordBack(this.chars, at, big), n), false);
			case "e":
			case "E":
				return this.go(this.repeatWord((at) => wordEnd(this.chars, at, big), n), true);
			case "f":
			case "F":
			case "t":
			case "T":
				this.wait = { kind: "find", cmd: key };
				return {};
			case ";":
			case ",": {
				if (!this.lastFind) return this.cancel();
				const { cmd, ch } = this.lastFind;
				const flipped = cmd === cmd.toLowerCase() ? cmd.toUpperCase() : cmd.toLowerCase();
				return this.find(key === ";" ? cmd : flipped, ch, n, true);
			}
			case "g":
				this.wait = { kind: "g" };
				return {};
		}
		return this.cancel();
	}

	private cancel(): LineResult {
		this.clearPending();
		return {};
	}

	private find(cmd: string, ch: string, n: number, again = false): LineResult {
		const forward = cmd === "f" || cmd === "t";
		const till = cmd === "t" || cmd === "T";
		let i = this.pos;
		// repeating t or T starts past the character it stopped next to
		if (again && till) i += forward ? 1 : -1;
		for (let found = 0; found < n; found++) {
			i += forward ? 1 : -1;
			while (i >= 0 && i < this.chars.length && this.chars[i] !== ch) i += forward ? 1 : -1;
			if (i < 0 || i >= this.chars.length) return this.cancel();
		}
		const to = till ? i + (forward ? -1 : 1) : i;
		return this.go(to, forward);
	}

	private afterWait(w: Wait, key: string): LineResult {
		const ch = key === "<Space>" ? " " : key;
		if ([...ch].length !== 1 && w.kind !== "g") return this.cancel();
		switch (w.kind) {
			case "register":
				return {};
			case "find":
				this.lastFind = { cmd: w.cmd, ch };
				return this.find(w.cmd, ch, this.times());
			case "replace":
				return this.replace(ch, this.times());
			case "object": {
				const range = this.textObject(ch, w.around);
				return range ? this.apply(range[0], range[1]) : this.cancel();
			}
			case "g":
				if (key === "e" || key === "E") return this.go(this.repeatWord((at) => wordEndBack(this.chars, at, key === "E"), this.times()), true);
				if (key === "g") return this.go(0, false);
				return this.cancel();
		}
	}

	private go(to: number, inclusive: boolean): LineResult {
		if (!this.op) {
			this.pos = to;
			this.clearPending();
			return {};
		}
		return to < this.pos ? this.apply(to, this.pos + (inclusive ? 1 : 0)) : this.apply(this.pos, to + (inclusive ? 1 : 0));
	}

	private snapshot() {
		this.undoStack.push({ text: this.text, pos: this.pos });
		this.redoStack = [];
		this.changedNow = true;
	}

	private apply(a: number, b: number): LineResult {
		const op = this.op;
		const taken = this.chars.slice(a, b).join("");
		this.clearPending();
		if (op === "y") {
			this.register = taken;
			this.pos = a;
			return { yanked: taken };
		}
		if (taken) {
			this.snapshot();
			this.register = taken;
			this.chars.splice(a, b - a);
		}
		this.pos = a;
		if (op !== "c") return {};
		this.changeOpen = true;
		return { exit: "insert" };
	}

	private replace(ch: string, n: number): LineResult {
		if (this.pos + n > this.chars.length) return this.cancel();
		this.snapshot();
		for (let i = 0; i < n; i++) this.chars[this.pos + i] = ch;
		this.pos += n - 1;
		this.clearPending();
		return {};
	}

	private toggleCase(n: number): LineResult {
		this.snapshot();
		const end = Math.min(this.chars.length, this.pos + n);
		for (let i = this.pos; i < end; i++) {
			const c = this.chars[i];
			this.chars[i] = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
		}
		this.pos = end;
		this.clearPending();
		return {};
	}

	private put(after: boolean, n: number): LineResult {
		const pasted = [...this.register.repeat(n)];
		this.clearPending();
		if (!pasted.length) return {};
		this.snapshot();
		const at = after && this.chars.length ? this.pos + 1 : this.pos;
		this.chars.splice(at, 0, ...pasted);
		this.pos = at + pasted.length - 1;
		return {};
	}

	private join(): LineResult {
		this.clearPending();
		const i = this.chars.indexOf("\n", this.pos);
		if (i < 0) return {};
		this.snapshot();
		this.chars[i] = " ";
		this.pos = i;
		return {};
	}

	private history(from: { text: string; pos: number }[], to: { text: string; pos: number }[]): LineResult {
		this.clearPending();
		const state = from.pop();
		if (!state) return {};
		to.push({ text: this.text, pos: this.pos });
		this.chars = [...state.text];
		this.pos = state.pos;
		return {};
	}

	private repeat(): LineResult {
		this.clearPending();
		if (!this.lastChange) return {};
		const keys = this.lastChange;
		this.typed = [];
		this.replaying = true;
		for (const k of keys) this.feed(k);
		this.replaying = false;
		this.typed = [];
		this.changedNow = false;
		return {};
	}

	private textObject(ch: string, around: boolean): [number, number] | undefined {
		if (ch === "w" || ch === "W") return this.wordObject(ch === "W", around);
		if (ch === '"' || ch === "'" || ch === "`") return this.quoteObject(ch, around);
		const pair = PAIRS[ch];
		return pair ? this.pairObject(pair[0], pair[1], around) : undefined;
	}

	private wordObject(big: boolean, around: boolean): [number, number] | undefined {
		const c = this.chars;
		if (!c.length) return undefined;
		const cls = charClass(c[this.pos], big);
		let a = this.pos;
		let b = this.pos + 1;
		while (a > 0 && charClass(c[a - 1], big) === cls) a--;
		while (b < c.length && charClass(c[b], big) === cls) b++;
		if (!around) return [a, b];
		if (cls === 0) {
			// around blanks takes the word after them
			if (b < c.length) {
				const w = charClass(c[b], big);
				while (b < c.length && charClass(c[b], big) === w) b++;
			}
			return [a, b];
		}
		const end = b;
		while (b < c.length && /\s/.test(c[b])) b++;
		if (b === end) while (a > 0 && /\s/.test(c[a - 1])) a--;
		return [a, b];
	}

	private quoteObject(q: string, around: boolean): [number, number] | undefined {
		const at = this.chars.flatMap((c, i) => (c === q ? [i] : []));
		for (let i = 0; i + 1 < at.length; i += 2) {
			const [open, close] = [at[i], at[i + 1]];
			if (this.pos > close) continue;
			if (!around) return [open + 1, close];
			let end = close + 1;
			while (end < this.chars.length && /\s/.test(this.chars[end])) end++;
			return [open, end];
		}
		return undefined;
	}

	private pairObject(open: string, close: string, around: boolean): [number, number] | undefined {
		const c = this.chars;
		let depth = 0;
		let a = this.pos;
		if (c[a] !== open) {
			for (a = c[a] === close ? a - 1 : a; a >= 0; a--) {
				if (c[a] === close) depth++;
				else if (c[a] === open && depth-- === 0) break;
			}
			if (a < 0) return undefined;
		}
		depth = 0;
		let b = a + 1;
		for (; b < c.length; b++) {
			if (c[b] === open) depth++;
			else if (c[b] === close && depth-- === 0) break;
		}
		if (b >= c.length) return undefined;
		return around ? [a, b + 1] : [a + 1, b];
	}
}

/** The prompt or the command line while typing: its text and where the cursor is, in characters. */
export class LineBuffer {
	private chars: string[] = [];
	pos = 0;

	get text(): string {
		return this.chars.join("");
	}

	/** Replace the text; the cursor goes to the end, where typing carries on. */
	set text(value: string) {
		this.chars = [...value];
		this.pos = this.chars.length;
	}

	/** The text before the cursor, the character under it (a space past the end), and the rest. */
	get parts(): [string, string, string] {
		return [this.chars.slice(0, this.pos).join(""), this.chars[this.pos] ?? " ", this.chars.slice(this.pos + 1).join("")];
	}

	insert(text: string) {
		const add = [...text];
		this.chars.splice(this.pos, 0, ...add);
		this.pos += add.length;
	}

	/** <BS>: false when there's nothing before the cursor. */
	backspace(): boolean {
		if (this.pos === 0) return false;
		this.chars.splice(--this.pos, 1);
		return true;
	}

	/** <Del> */
	deleteForward() {
		this.chars.splice(this.pos, 1);
	}

	/** <C-w>: the word before the cursor, and the blanks after it. */
	deleteWordBack() {
		const before = this.chars.slice(0, this.pos).join("").replace(/\S*\s*$/, "");
		const n = [...before].length;
		this.chars.splice(n, this.pos - n);
		this.pos = n;
	}

	/** <C-u>: everything before the cursor. */
	deleteToStart() {
		this.chars.splice(0, this.pos);
		this.pos = 0;
	}

	move(to: "left" | "right" | "home" | "end" | "word_left" | "word_right") {
		const len = this.chars.length;
		if (to === "left") this.pos = Math.max(0, this.pos - 1);
		else if (to === "right") this.pos = Math.min(len, this.pos + 1);
		else if (to === "home") this.pos = 0;
		else if (to === "end") this.pos = len;
		else if (to === "word_left") this.pos = wordBack(this.chars, this.pos, true);
		else this.pos = wordForward(this.chars, this.pos, true);
	}
}

/**
 * <Up> and <Down> through earlier lines, like vim's command-line history:
 * only the ones that start with what was typed, and back to what was typed
 * past the newest.
 */
export class HistoryWalk {
	private at = -1;
	private prefix = "";
	private draft = "";
	private shown = "";

	/** The line `dir` steps away (-1 older, 1 newer), or undefined when there's none. `entries` are oldest first. */
	step(entries: readonly string[], current: string, dir: 1 | -1): string | undefined {
		// editing a recalled line starts a new walk from what's there now
		if (this.at >= 0 && current !== this.shown) this.at = -1;
		if (this.at < 0) {
			if (dir > 0) return undefined;
			this.draft = current;
			this.prefix = current;
			this.at = entries.length;
		}
		for (let i = this.at + dir; i >= 0 && i < entries.length; i += dir) {
			if (entries[i].startsWith(this.prefix) && entries[i] !== current) {
				this.at = i;
				this.shown = entries[i];
				return entries[i];
			}
		}
		if (dir < 0) return undefined;
		this.at = -1;
		return this.draft;
	}
}

/** Add a line to a history: the newest last, an earlier copy of it dropped, at most `max` kept. */
export function remember(history: string[], line: string, max = 200) {
	if (!line.trim()) return;
	const i = history.indexOf(line);
	if (i >= 0) history.splice(i, 1);
	history.push(line);
	if (history.length > max) history.splice(0, history.length - max);
}
