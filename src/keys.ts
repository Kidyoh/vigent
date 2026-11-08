/**
 * Vim-style keymaps.
 *
 * Keys use vim notation: `j`, `gg`, `<C-d>`, `<S-Tab>`, `<M-x>`, `<CR>`,
 * `<Esc>`, `<Space>`, `<leader>`, `<F5>`. A mapping's right-hand side is one
 * of (or a list of):
 *
 *   "session.next"           an action
 *   ":colorscheme nord<CR>"  an ex command (without <CR>: opens the command line prefilled)
 *   "gg"                     other keys, replayed through the built-in keymap (like noremap)
 *   "<Nop>" or false         nothing: unbinds the key
 *
 * Like vim, a key that starts a longer mapping waits `timeoutlen` ms for the
 * rest; that is what makes `jk` = `<Esc>` in insert mode work.
 */
import { parseKey } from "./tui.js";
import { didYouMean } from "./suggest.js";

export type KeyMode = "normal" | "insert" | "visual" | "command";
export const KEY_MODES: KeyMode[] = ["normal", "insert", "visual", "command"];

/** vigent's default <leader>, as in most Neovim configs (vim's own default is "\\") */
export const DEFAULT_LEADER = "<Space>";

export type Rhs =
	| { kind: "action"; name: string; arg?: string }
	| { kind: "ex"; cmd: string; execute: boolean }
	| { kind: "keys"; keys: string[] }
	| { kind: "nop" };

export interface Binding {
	/** canonical key sequence, e.g. ["<Space>", "t"] */
	keys: string[];
	rhs: Rhs[];
	/** the right-hand side as written, for listings */
	rhsText: string;
	user: boolean;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ACTIONS: Record<string, string> = {
	"mode.normal": "back to NORMAL mode",
	"mode.insert": "write a prompt to the focused agent (INSERT)",
	"mode.command": "open the : command line",
	"mode.search": "search the transcript",
	"mode.search_back": "search the transcript backward",
	"mode.visual": "select transcript lines (VISUAL)",
	"cursor.down": "move the VISUAL cursor down",
	"cursor.up": "move the VISUAL cursor up",
	"cursor.half_down": "move the VISUAL cursor down half a page",
	"cursor.half_up": "move the VISUAL cursor up half a page",
	"cursor.top": "move the VISUAL cursor to the top",
	"cursor.bottom": "move the VISUAL cursor to the bottom",
	"visual.yank": "copy the selection to the clipboard",
	"visual.inner_block": "select the code block under the cursor",
	"visual.swap": "jump to the other end of the selection",
	"message.next": "jump to the next message",
	"message.prev": "jump to the previous message",
	"yank.reply": "copy the agent's last reply",
	"yank.block": "copy the nearest code block",
	"scroll.down": "scroll down one line",
	"scroll.up": "scroll up one line",
	"scroll.half_down": "scroll down half a page",
	"scroll.half_up": "scroll up half a page",
	"scroll.page_down": "scroll down a page",
	"scroll.page_up": "scroll up a page",
	"scroll.top": "jump to the top of the transcript",
	"scroll.bottom": "jump to the bottom of the transcript",
	"session.next": "next session",
	"session.prev": "previous session",
	"session.alternate": "last focused session",
	"session.goto": "session N (session.goto 3)",
	"session.new": "spawn a new agent",
	"session.kill": "kill the focused agent (asks first)",
	"session.abort": "stop the focused agent's current run",
	"session.pause": "pause the agent and hold its queued prompts",
	"session.resume": "resume a paused agent",
	"session.tree": "the conversation tree: go back to an earlier point",
	"sidebar.focus": "sessions sidebar: j/k pick an agent, Enter or Esc back",
	"fold.toggle": "fold / unfold tool output",
	"fold.open_all": "unfold all tool output",
	"fold.close_all": "fold all tool output",
	"search.next": "next search match",
	"search.prev": "previous search match",
	"search.clear": "clear search highlighting",
	"edit.submit": "send the prompt / run the command line",
	"edit.backspace": "delete the character before the cursor",
	"edit.delete_word": "delete the word before the cursor",
	"edit.clear": "clear the prompt / command line",
	"theme.picker": "pick a colorscheme",
	"app.help": "show all keys",
	"app.dashboard": "all agents at a glance",
	"app.redraw": "redraw the screen",
	"app.quit": "quit vigent (asks if agents are running)",
	"app.quit_force": "quit even if agents are running",
	"app.quit_hint": "explain how to quit",
	noop: "do nothing",
};

/** Built-in keymap, in the same notation users write. */
export const DEFAULT_KEYS: Record<KeyMode, Record<string, string>> = {
	normal: {
		i: "mode.insert",
		a: "mode.insert",
		o: "mode.insert",
		":": "mode.command",
		"/": "mode.search",
		"?": "mode.search_back",
		v: "mode.visual",
		V: "mode.visual",
		j: "scroll.down",
		"<Down>": "scroll.down",
		k: "scroll.up",
		"<Up>": "scroll.up",
		"<C-d>": "scroll.half_down",
		"<C-u>": "scroll.half_up",
		"<C-f>": "scroll.page_down",
		"<PageDown>": "scroll.page_down",
		"<C-b>": "scroll.page_up",
		"<PageUp>": "scroll.page_up",
		gg: "scroll.top",
		G: "scroll.bottom",
		"]s": "session.next",
		"[s": "session.prev",
		"<C-^>": "session.alternate",
		...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), `session.goto ${i + 1}`])),
		za: "fold.toggle",
		zR: "fold.open_all",
		zM: "fold.close_all",
		n: "search.next",
		N: "search.prev",
		"{": "message.prev",
		"}": "message.next",
		yy: "yank.reply",
		yib: "yank.block",
		dd: "session.kill",
		"<Esc>": "search.clear",
		"<C-c>": "session.abort",
		"<C-l>": "app.redraw",
		"<leader>n": ":new ",
		"<leader>d": ":diff<CR>",
		"<leader>m": ":merge<CR>",
		"<leader>p": ":pr<CR>",
		"<leader>q": ":queue ",
		"<leader>t": "theme.picker",
		"<leader>D": ":dash<CR>",
		"<leader>u": "session.tree",
		"<leader>s": ":settings<CR>",
		"<leader>r": ":review<CR>",
		"<leader>T": ":templates<CR>",
		"<leader>M": ":model<CR>",
		"<leader>e": "sidebar.focus",
		"<leader>R": ":effort<CR>",
		"<leader>E": ":engine<CR>",
		ZZ: "app.quit",
		ZQ: "app.quit_force",
		q: "app.quit_hint",
	},
	visual: {
		j: "cursor.down",
		"<Down>": "cursor.down",
		k: "cursor.up",
		"<Up>": "cursor.up",
		"<C-d>": "cursor.half_down",
		"<C-u>": "cursor.half_up",
		gg: "cursor.top",
		G: "cursor.bottom",
		y: "visual.yank",
		ib: "visual.inner_block",
		o: "visual.swap",
		"<Esc>": "mode.normal",
		"<C-c>": "mode.normal",
		v: "mode.normal",
		V: "mode.normal",
	},
	insert: {
		"<Esc>": "mode.normal",
		"<C-c>": "mode.normal",
		"<CR>": "edit.submit",
		"<BS>": "edit.backspace",
		"<C-h>": "edit.backspace",
		"<C-w>": "edit.delete_word",
		"<C-u>": "edit.clear",
	},
	command: {
		"<Esc>": "mode.normal",
		"<C-c>": "mode.normal",
		"<CR>": "edit.submit",
		"<BS>": "edit.backspace",
		"<C-h>": "edit.backspace",
		"<C-w>": "edit.delete_word",
		"<C-u>": "edit.clear",
	},
};

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = {
	space: "Space",
	tab: "Tab",
	cr: "CR",
	enter: "CR",
	return: "CR",
	esc: "Esc",
	escape: "Esc",
	bs: "BS",
	backspace: "BS",
	del: "Del",
	delete: "Del",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
	insert: "Insert",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** Build a canonical token from modifiers + a base key ("Space", "x", "F5"). */
function token(mods: Set<string>, base: string): string {
	let key = base;
	if (key.length === 1 && mods.has("S") && !mods.has("C") && !mods.has("M") && !mods.has("D")) {
		mods.delete("S");
		key = key.toUpperCase();
	}
	if (key.length === 1 && mods.has("M") && !mods.has("C") && key !== key.toLowerCase()) {
		// Alt keeps case apart, as <M-S-g>, so Esc-then-G stays G
		mods.add("S");
		key = key.toLowerCase();
	}
	if (key.length === 1 && (mods.has("C") || mods.has("M"))) key = key.toLowerCase();
	if (mods.size === 0) {
		if (key === "<") return "<lt>";
		return key.length === 1 ? key : `<${key}>`;
	}
	const order = ["C", "M", "S", "D"].filter((m) => mods.has(m));
	return `<${order.map((m) => `${m}-`).join("")}${key === "<" ? "lt" : key}>`;
}

/** Parse the inside of <...>. Returns undefined if it isn't a key name (then `<` is literal). */
function parseBracket(inner: string): string | undefined {
	const lower = inner.toLowerCase();
	if (lower === "lt") return "<lt>";
	if (lower === "bar") return "|";
	if (lower === "bslash") return "\\";
	const m = /^((?:[cmasd]-)+)(.+)$/i.exec(inner);
	const mods = new Set<string>();
	let base = inner;
	if (m) {
		for (const c of m[1].toUpperCase().replace(/-/g, "")) mods.add(c === "A" ? "M" : c);
		base = m[2];
	}
	const named = NAMED[base.toLowerCase()];
	if (named) return token(mods, named);
	if (base.toLowerCase() === "lt") return token(mods, "<");
	if (mods.size > 0 && [...base].length === 1) return token(mods, base);
	return undefined;
}

/**
 * Parse vim key notation into canonical tokens.
 * `<leader>` expands to the given leader. Throws on an empty sequence.
 */
export function parseKeys(notation: string, leader = DEFAULT_LEADER): string[] {
	const out: string[] = [];
	const chars = [...notation];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		if (ch === "<") {
			const close = chars.indexOf(">", i + 1);
			if (close > i + 1) {
				const inner = chars.slice(i + 1, close).join("");
				if (inner.toLowerCase() === "leader") {
					out.push(...parseKeys(leader, "\\"));
					i = close;
					continue;
				}
				const t = parseBracket(inner);
				if (t) {
					out.push(t);
					i = close;
					continue;
				}
			}
			out.push("<lt>");
			continue;
		}
		out.push(ch === " " ? "<Space>" : ch);
	}
	if (out.length === 0) throw new Error("empty key sequence");
	return out;
}

/** Display a token sequence the way vim prints mappings. */
export function formatKeys(keys: string[]): string {
	return keys.join("");
}

const PI_NAMED: Record<string, string> = {
	space: "Space",
	tab: "Tab",
	enter: "CR",
	return: "CR",
	escape: "Esc",
	esc: "Esc",
	backspace: "BS",
	delete: "Del",
	insert: "Insert",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	home: "Home",
	end: "End",
	pageUp: "PageUp",
	pageDown: "PageDown",
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** Convert raw terminal input to a canonical token, or undefined if it isn't a key. */
export function keyFromInput(data: string): string | undefined {
	if (data === "\x1e") return "<C-^>";
	const id = parseKey(data);
	if (id === undefined) {
		const chars = [...data];
		if (chars.length === 1 && data >= " " && data !== "\x7f") return data === "<" ? "<lt>" : data;
		// Esc + any printable key (pi-tui only names Esc + lowercase letters): Alt + that key
		if (chars.length === 2 && chars[0] === "\x1b" && chars[1] >= " " && chars[1] !== "\x7f") {
			return token(new Set(["M"]), chars[1]);
		}
		return undefined;
	}
	const parts = id.split("+");
	const base = parts.pop() as string;
	const mods = new Set(
		parts.map((p) => ({ ctrl: "C", alt: "M", shift: "S", super: "D" })[p] ?? "").filter((m) => m !== ""),
	);
	const named = PI_NAMED[base];
	if (named) {
		if (named === "Space" && mods.size === 0) return "<Space>";
		return token(mods, named);
	}
	return token(mods, base);
}

/** The text a token types in INSERT / command-line mode, if any. */
export function tokenText(t: string): string | undefined {
	if (t === "<Space>") return " ";
	if (t === "<lt>") return "<";
	if ([...t].length === 1) return t;
	return undefined;
}

// ---------------------------------------------------------------------------
// Right-hand sides
// ---------------------------------------------------------------------------

/** Parse a mapping's right-hand side. Throws with a readable message on errors. */
export function parseRhs(value: unknown, leader = DEFAULT_LEADER): Rhs[] {
	if (value === false || value === "" || (typeof value === "string" && /^<nop>$/i.test(value.trim()))) {
		return [{ kind: "nop" }];
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return [{ kind: "nop" }];
		return value.flatMap((v) => parseRhs(v, leader));
	}
	if (typeof value !== "string") throw new Error("should be an action, an ex command, keys, or false");
	const v = value.trim();

	// ":cmd<CR>" runs it; ":cmd " (no <CR>) opens the command line with that text, trailing space kept
	const ex = /^(?::|<cmd>)([\s\S]*?)(<cr>|<enter>|<return>)?$/i.exec(value.trimStart());
	if (ex && /^(:|<cmd>)/i.test(v)) {
		const execute = Boolean(ex[2]) || /^<cmd>/i.test(v);
		return [{ kind: "ex", cmd: execute ? ex[1].trim() : ex[1].trimStart(), execute }];
	}

	const action = /^([a-z_]+(?:\.[a-z_]+)?)(?:\s+(\S+))?$/.exec(v);
	if (action && (action[1].includes(".") || action[1] === "noop")) {
		if (!(action[1] in ACTIONS)) throw new Error(`unknown action '${action[1]}'${didYouMean(action[1], Object.keys(ACTIONS))}`);
		return [{ kind: "action", name: action[1], arg: action[2] }];
	}

	return [{ kind: "keys", keys: parseKeys(v, leader) }];
}

function rhsToText(value: unknown): string {
	if (value === false) return "<Nop>";
	if (Array.isArray(value)) return value.map(rhsToText).join(", ");
	return String(value);
}

// ---------------------------------------------------------------------------
// Keymap
// ---------------------------------------------------------------------------

export interface LookupResult {
	exact?: Binding;
	/** a longer mapping starts with these keys */
	prefix: boolean;
}

export class Keymap {
	private maps = perMode(() => new Map<string, Binding>());
	private defaults = perMode(() => new Map<string, Binding>());
	private prefixes = perMode(() => new Set<string>());
	private defaultPrefixes = perMode(() => new Set<string>());

	constructor(public leader = DEFAULT_LEADER) {
		for (const mode of KEY_MODES) {
			for (const [lhs, rhs] of Object.entries(DEFAULT_KEYS[mode])) {
				const b: Binding = { keys: parseKeys(lhs, leader), rhs: parseRhs(rhs, leader), rhsText: rhs, user: false };
				this.defaults[mode].set(b.keys.join(""), b);
				this.maps[mode].set(b.keys.join(""), b);
			}
			this.defaultPrefixes[mode] = computePrefixes(this.defaults[mode]);
			this.prefixes[mode] = computePrefixes(this.maps[mode]);
		}
	}

	/** Add or replace a mapping. Throws on bad notation or an unknown action. */
	set(mode: KeyMode, lhs: string, rhs: unknown): Binding {
		const keys = parseKeys(lhs, this.leader);
		const b: Binding = { keys, rhs: parseRhs(rhs, this.leader), rhsText: rhsToText(rhs), user: true };
		this.maps[mode].set(keys.join(""), b);
		this.prefixes[mode] = computePrefixes(this.maps[mode]);
		return b;
	}

	/** Remove a mapping (built-in or user). Returns false if nothing was mapped. */
	unset(mode: KeyMode, lhs: string): boolean {
		const removed = this.maps[mode].delete(parseKeys(lhs, this.leader).join(""));
		this.prefixes[mode] = computePrefixes(this.maps[mode]);
		return removed;
	}

	lookup(mode: KeyMode, keys: string[], builtinOnly = false): LookupResult {
		const map = builtinOnly ? this.defaults[mode] : this.maps[mode];
		const prefixes = builtinOnly ? this.defaultPrefixes[mode] : this.prefixes[mode];
		const k = keys.join("");
		return { exact: map.get(k), prefix: prefixes.has(k) };
	}

	/** All active bindings for a mode, in a stable order. */
	bindings(mode: KeyMode): Binding[] {
		return [...this.maps[mode].values()];
	}
}

function perMode<T>(make: () => T): Record<KeyMode, T> {
	return Object.fromEntries(KEY_MODES.map((m) => [m, make()])) as Record<KeyMode, T>;
}

function computePrefixes(map: Map<string, Binding>): Set<string> {
	const out = new Set<string>();
	for (const b of map.values()) {
		for (let i = 1; i < b.keys.length; i++) out.add(b.keys.slice(0, i).join(""));
	}
	return out;
}

/** Build a keymap from config: `leader` plus `[keys.normal]`, `[keys.insert]`, `[keys.command]`. */
export function buildKeymap(
	leader: string | undefined,
	keys: Partial<Record<KeyMode, Record<string, unknown>>>,
): { keymap: Keymap; warnings: string[] } {
	const warnings: string[] = [];
	let leaderNotation = DEFAULT_LEADER;
	if (leader !== undefined) {
		try {
			parseKeys(leader);
			leaderNotation = leader;
		} catch {
			warnings.push(`config: leader '${leader}' is not a key`);
		}
	}
	const keymap = new Keymap(leaderNotation);
	for (const mode of KEY_MODES) {
		for (const [lhs, rhs] of Object.entries(keys[mode] ?? {})) {
			try {
				keymap.set(mode, lhs, rhs);
			} catch (err) {
				warnings.push(`config [keys.${mode}] "${lhs}": ${(err as Error).message}`);
			}
		}
	}
	return { keymap, warnings };
}

// ---------------------------------------------------------------------------
// Sequencer: turns key presses into bindings, with vim's timeout
// ---------------------------------------------------------------------------

export interface SequencerHost {
	mode(): KeyMode;
	/** run a binding (or, with binding undefined, handle unmapped keys) */
	run(binding: Binding | undefined, keys: string[]): void;
	timeoutlen(): number;
	/** pending keys changed (for showcmd) */
	changed(): void;
	/**
	 * which-key: after a short pause on keys that only start mappings, show
	 * what can follow. Return true to keep waiting for the next key (no timeout).
	 */
	hint?(keys: string[]): boolean;
	/** ms before hint() (default 300) */
	hintDelay?(): number;
}

export class KeySequencer {
	private pending: string[] = [];
	private timer?: ReturnType<typeof setTimeout>;
	private hintTimer?: ReturnType<typeof setTimeout>;
	/** a which-key hint is showing: wait for the next key, however long */
	private holding = false;

	constructor(
		private keymap: Keymap,
		private host: SequencerHost,
	) {}

	get pendingKeys(): string[] {
		return this.pending;
	}

	feed(key: string) {
		this.cancelTimer();
		// Esc while waiting on a prefix: drop it, like which-key
		if (key === "<Esc>" && this.pending.length > 0 && !this.keymap.lookup(this.host.mode(), this.pending).exact) {
			this.pending = [];
			this.host.changed();
			return;
		}
		this.pending.push(key);
		const r = this.keymap.lookup(this.host.mode(), this.pending);
		if (r.prefix) {
			this.timer = setTimeout(() => this.timeout(), this.host.timeoutlen());
			if (!r.exact && this.host.hint) {
				const delay = Math.min(this.host.hintDelay?.() ?? 300, Math.max(0, this.host.timeoutlen() - 50));
				this.hintTimer = setTimeout(() => {
					this.hintTimer = undefined;
					if (this.pending.length > 0 && this.host.hint?.(this.pending)) {
						this.holding = true;
						if (this.timer) clearTimeout(this.timer);
						this.timer = undefined;
					}
				}, delay);
			}
			this.host.changed();
			return;
		}
		const keys = this.pending;
		this.pending = [];
		if (r.exact) {
			this.host.run(r.exact, keys);
		} else {
			this.resolveUnmatched(keys);
		}
		this.host.changed();
	}

	/** Like vim: when the wait runs out, use the shorter mapping (or the keys themselves). */
	private timeout() {
		this.timer = undefined;
		const keys = this.pending;
		this.pending = [];
		const r = this.keymap.lookup(this.host.mode(), keys);
		if (r.exact) this.host.run(r.exact, keys);
		else this.resolveUnmatched(keys);
		this.host.changed();
	}

	/**
	 * The keys matched nothing. The first key(s) may still be a shorter mapping
	 * (`g` mapped, then `gx` typed); run the longest one that matches and feed the rest.
	 */
	private resolveUnmatched(keys: string[]) {
		if (keys.length === 1) {
			this.host.run(undefined, keys);
			return;
		}
		for (let n = keys.length - 1; n >= 1; n--) {
			const r = this.keymap.lookup(this.host.mode(), keys.slice(0, n));
			if (r.exact) {
				this.host.run(r.exact, keys.slice(0, n));
				for (const k of keys.slice(n)) this.feed(k);
				return;
			}
		}
		this.host.run(undefined, [keys[0]]);
		for (const k of keys.slice(1)) this.feed(k);
	}

	/** Drop pending keys (e.g. when a picker opens). */
	reset() {
		this.cancelTimer();
		this.pending = [];
	}

	private cancelTimer() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.hintTimer) clearTimeout(this.hintTimer);
		this.hintTimer = undefined;
		this.holding = false;
	}

	/** a which-key hint is up, waiting for the next key */
	get waiting(): boolean {
		return this.holding && this.pending.length > 0;
	}
}

/**
 * Replay keys through the built-in keymap only (non-recursive, like noremap).
 * Used for mappings whose right-hand side is other keys.
 */
export function replayKeys(keymap: Keymap, host: Pick<SequencerHost, "mode" | "run">, keys: string[]) {
	let i = 0;
	while (i < keys.length) {
		const mode = host.mode();
		let matched = 0;
		let binding: Binding | undefined;
		for (let n = keys.length - i; n >= 1; n--) {
			const r = keymap.lookup(mode, keys.slice(i, i + n), true);
			if (r.exact) {
				matched = n;
				binding = r.exact;
				break;
			}
		}
		if (binding) {
			host.run(binding, keys.slice(i, i + matched));
			i += matched;
		} else {
			host.run(undefined, [keys[i]]);
			i += 1;
		}
	}
}
