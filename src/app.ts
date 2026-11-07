/**
 * The Vigent app: a full-screen modal TUI component rendered by pi-tui.
 *
 * Layout (vim-style):
 *   ┌ sidebar │ transcript ┐
 *   │ statusline           │
 *   └ cmdline              ┘
 */
import {
	type Component,
	type Terminal,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { applySetCommand, DEFAULT_UI, type UiOptions } from "./config.js";
import { type FloatLine, type FloatOptions, TextFloat } from "./float.js";
import {
	ACTIONS,
	type Binding,
	formatKeys,
	KEY_MODES,
	type KeyMode,
	KeySequencer,
	Keymap,
	keyFromInput,
	parseKeys,
	type Rhs,
	replayKeys,
	tokenText,
} from "./keys.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { setDetached } from "./agents.js";
import { copyToClipboard } from "./clipboard.js";
import { splitView, unifiedView } from "./diffview.js";
import { TREE_GLYPHS, type TreeRow } from "./tree.js";
import { transcriptMarkdown } from "./export.js";
import { renderMarkdown } from "./markdown.js";
import { PICKER_ICONS, ThemePicker } from "./picker.js";
import { mergeWorktree, openPullRequest } from "./review.js";
import type { Session, SessionState } from "./session.js";
import { type Attr, listThemes, loadTheme, type Painter, RESET, sgr, type Theme } from "./theme.js";
import { parseHighlightCommand } from "./vimcolors.js";
import {
	DEFAULT_WORKTREE,
	type DiffStat,
	diffText,
	findWorktree,
	type WorktreeInfo,
	listWorktrees,
	removeWorktree,
	type WorktreeConfig,
} from "./worktree.js";

/** Where agents' worktrees live; root is undefined outside a git repo. */
export interface Workspace {
	root?: string;
	config: WorktreeConfig;
}

export type Mode = "NORMAL" | "INSERT" | "VISUAL" | "COMMAND" | "SEARCH";

const MODE_GROUP: Record<Mode, string> = {
	NORMAL: "VigentModeNormal",
	INSERT: "VigentModeInsert",
	VISUAL: "VigentModeVisual",
	COMMAND: "VigentModeCommand",
	SEARCH: "VigentModeCommand",
};

interface Icons {
	spinner: string[];
	state: Record<Exclude<SessionState, "running">, string>;
	tee: string;
	last: string;
	pipe: string;
	sep: string;
	worktree: string;
	prompt: string;
	folded: string;
	open: string;
	cursor: string;
	minus: string;
	bullet: string;
	queued: string;
	open_agent: string;
	here: string;
}

const ICONS: Record<UiOptions["icons"], Icons> = {
	unicode: {
		spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		state: { waiting: "◐", idle: "○", paused: "‖", error: "✗" },
		tee: "├╴",
		last: "└╴",
		pipe: "│ ",
		sep: "│",
		worktree: "⎇ ",
		prompt: "❯ ",
		folded: "▸",
		open: "▾",
		cursor: "▍",
		minus: "−",
		bullet: "•",
		queued: "⧗",
		open_agent: "▸",
		here: "●",
	},
	ascii: {
		spinner: ["|", "/", "-", "\\"],
		state: { waiting: "~", idle: "o", paused: "=", error: "x" },
		tee: "|-",
		last: "`-",
		pipe: "| ",
		sep: "|",
		worktree: "wt:",
		prompt: "> ",
		folded: "+",
		open: "-",
		cursor: "_",
		minus: "-",
		bullet: "-",
		queued: "+",
		open_agent: ">",
		here: "*",
	},
};

interface PaneLine {
	text: string; // with ANSI
	plain: string; // for search and yank
	/** index of the transcript item this line renders */
	item?: number;
	/** first line of a message (for { and }) */
	start?: boolean;
	/** code block id: fenced code in replies, or unfolded tool output */
	block?: number;
	/** a code block's language label (selected with the block, never copied) */
	label?: boolean;
}

export class App implements Component {
	mode: Mode = "NORMAL";
	sessions: Session[] = [];
	focusIdx = 0;
	altIdx = 0;

	private cmdBuf = "";
	private inputBuf = "";
	private message = "";
	private messageGroup = "Comment";
	private scrollOffset = 0; // lines from bottom
	private searchQuery = "";
	private matches: number[] = [];
	private matchIdx = -1;
	private spinnerFrame = 0;
	private spinnerTimer?: ReturnType<typeof setInterval>;
	private statTimer?: ReturnType<typeof setInterval>;

	private paneCache: { lines: PaneLine[]; key: string } = { lines: [], key: "" };

	onQuit: () => void = () => {};
	/** reopen an agent in an existing worktree (`:attach`) */
	attachSession: (worktree: WorktreeInfo) => Session = () => {
		throw new Error("attaching isn't available here");
	};

	/** create an agent; `worktree: false` runs it in the current checkout */
	newSession: (name: string, opts: { worktree: boolean; model?: string }) => Session = () => {
		throw new Error("newSession factory not set");
	};

	private seq: KeySequencer;
	private searchBackward = false;
	/** VISUAL selection, as line indices into the transcript pane */
	private visual = { anchor: 0, cursor: 0 };
	/** a y/n question in the command line (dd, quitting with agents running) */
	private confirm?: { question: string; onYes: () => void };
	/** copies text to the system clipboard; returns how (replaced in tests) */
	clipboard: (text: string) => string = (text) => copyToClipboard(text, (d) => this.terminal.write(d));

	constructor(
		private tui: TUI,
		private terminal: Terminal,
		public painter: Painter,
		public ui: UiOptions = { ...DEFAULT_UI },
		public keymap: Keymap = new Keymap(),
		public workspace: Workspace = { config: DEFAULT_WORKTREE },
	) {
		this.applyColorMode();
		this.seq = new KeySequencer(keymap, {
			mode: () => this.keyMode(),
			run: (binding, keys) => this.runBinding(binding, keys),
			timeoutlen: () => this.ui.timeoutlen,
			changed: () => this.tui.requestRender(),
		});
	}

	private get icons(): Icons {
		return ICONS[this.ui.icons];
	}

	private spinner(): string {
		const frames = this.icons.spinner;
		return frames[this.spinnerFrame % frames.length];
	}

	// ------------------------------------------------------------------ state

	get focusedSession(): Session | undefined {
		return this.sessions[this.focusIdx];
	}

	addSession(s: Session, focus = true) {
		this.sessions.push(s);
		s.onChange(() => {
			this.syncSpinner();
			this.tui.requestRender();
		});
		if (focus) {
			this.altIdx = this.focusIdx;
			this.focusIdx = this.sessions.length - 1;
		}
		s.refreshStat(0); // reopened agents show their changes right away
		if (s.worktree?.path && !this.statTimer) {
			// edits made outside the agent (you, your editor) show up too
			this.statTimer = setInterval(() => {
				for (const x of this.sessions) x.refreshStat(0);
			}, 5000);
			this.statTimer.unref?.();
		}
		this.syncSpinner();
		this.tui.requestRender();
	}

	private focusSession(idx: number) {
		if (idx < 0 || idx >= this.sessions.length || idx === this.focusIdx) return;
		this.altIdx = this.focusIdx;
		this.focusIdx = idx;
		this.scrollOffset = 0;
		this.clearSearch();
		this.focusedSession?.refreshStat(0);
	}

	private syncSpinner() {
		const running = this.sessions.some((s) => s.state === "running");
		if (running && !this.spinnerTimer) {
			this.spinnerTimer = setInterval(() => {
				this.spinnerFrame = (this.spinnerFrame + 1) % 120;
				this.tui.requestRender();
			}, 120);
			this.spinnerTimer.unref?.(); // animation only; the terminal keeps the app alive
		} else if (!running && this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	setTheme(theme: Theme) {
		this.painter.setTheme(theme);
		this.repaint();
	}

	private repaint() {
		this.invalidate();
		this.tui.requestRender(true);
	}

	/** Show a startup message (config warnings etc.) in the command line. */
	notify(text: string, group = "WarningMsg") {
		this.setMessage(text, group);
		this.tui.requestRender();
	}

	stopTimers() {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		if (this.statTimer) clearInterval(this.statTimer);
	}

	invalidate(): void {
		this.paneCache.key = "";
	}

	// ------------------------------------------------------------------ input

	private keyMode(): KeyMode {
		if (this.mode === "NORMAL") return "normal";
		if (this.mode === "INSERT") return "insert";
		if (this.mode === "VISUAL") return "visual";
		return "command";
	}

	private applyColorMode() {
		this.painter.setColorMode(this.ui.termguicolors ? "truecolor" : "256");
	}

	/** Ask a y/n question in the command line, like vim's confirm prompts. */
	private ask(question: string, onYes: () => void) {
		this.seq.reset();
		this.confirm = { question, onYes };
	}

	handleInput(data: string): void {
		if (this.confirm) {
			const { onYes } = this.confirm;
			this.confirm = undefined;
			this.message = "";
			if (data === "y" || data === "Y") onYes();
			this.tui.requestRender();
			return;
		}
		if (data.startsWith("\x1b[200~")) {
			// bracketed paste: insert as text, never as mappings
			this.typeText(data.slice(6).replace(/\x1b\[201~$/, "").replace(/\r?\n/g, " "));
			this.tui.requestRender();
			return;
		}
		const key = keyFromInput(data);
		if (!key) return;
		if (this.mode === "NORMAL" && this.seq.pendingKeys.length === 0) this.message = "";
		for (const k of this.splitEscape(key)) this.seq.feed(k);
		this.tui.requestRender();
	}

	/**
	 * Esc followed quickly by a key arrives as one Alt-key sequence (<M-j>).
	 * Vim resolves this with a timeout; here, an Alt key that nothing is
	 * mapped to is read as Esc and then the key, which is what was typed.
	 */
	private splitEscape(key: string): string[] {
		const m = /^<M-(.+)>$/.exec(key);
		if (!m) return [key];
		const r = this.keymap.lookup(this.keyMode(), [...this.seq.pendingKeys, key]);
		if (r.exact || r.prefix) return [key];
		const rest = m[1];
		return ["<Esc>", ...parseKeys([...rest].length === 1 ? rest : `<${rest}>`)];
	}

	private typeText(text: string) {
		if (this.mode === "INSERT") this.inputBuf += text;
		else if (this.mode === "COMMAND" || this.mode === "SEARCH") this.cmdBuf += text;
	}

	private runBinding(binding: Binding | undefined, keys: string[]) {
		if (!binding) {
			for (const k of keys) {
				const text = tokenText(k);
				if (text !== undefined) this.typeText(text);
			}
			return;
		}
		for (const rhs of binding.rhs) this.runRhs(rhs);
	}

	private runRhs(rhs: Rhs) {
		switch (rhs.kind) {
			case "action":
				this.runAction(rhs.name, rhs.arg);
				return;
			case "ex":
				if (rhs.execute) {
					this.exec(rhs.cmd);
				} else {
					this.mode = "COMMAND";
					this.cmdBuf = rhs.cmd;
				}
				return;
			case "keys":
				replayKeys(this.keymap, { mode: () => this.keyMode(), run: (b, k) => this.runBinding(b, k) }, rhs.keys);
				return;
			case "nop":
				return;
		}
	}

	/** Every built-in behavior, by the name used in keymaps. */
	runAction(name: string, arg?: string) {
		const half = Math.floor(this.contentHeight() / 2);
		const page = Math.max(1, this.contentHeight() - 2);
		const count = this.sessions.length;
		switch (name) {
			case "mode.normal":
				if (this.mode === "COMMAND" || this.mode === "SEARCH") this.cmdBuf = "";
				this.mode = "NORMAL";
				return;
			case "mode.insert":
				this.mode = "INSERT";
				return;
			case "mode.command":
				this.mode = "COMMAND";
				this.cmdBuf = "";
				return;
			case "mode.search":
			case "mode.search_back":
				this.mode = "SEARCH";
				this.searchBackward = name === "mode.search_back";
				this.cmdBuf = "";
				return;
			case "mode.visual": {
				const lines = this.buildPaneLines(this.paneWidth());
				if (lines.length === 0) return;
				const bottom = this.viewRange(lines.length).end - 1;
				this.visual = { anchor: bottom, cursor: bottom };
				this.mode = "VISUAL";
				return;
			}
			case "cursor.down":
				return this.moveCursor(1);
			case "cursor.up":
				return this.moveCursor(-1);
			case "cursor.half_down":
				return this.moveCursor(half);
			case "cursor.half_up":
				return this.moveCursor(-half);
			case "cursor.top":
				return this.moveCursor(-Number.MAX_SAFE_INTEGER);
			case "cursor.bottom":
				return this.moveCursor(Number.MAX_SAFE_INTEGER);
			case "visual.swap":
				this.visual = { anchor: this.visual.cursor, cursor: this.visual.anchor };
				return this.revealLine(this.visual.cursor);
			case "visual.inner_block": {
				const lines = this.buildPaneLines(this.paneWidth());
				const block = lines[this.visual.cursor]?.block;
				if (block === undefined) {
					this.setMessage("no code block under the cursor", "WarningMsg");
					return;
				}
				const idx = lines.map((l, i) => (l.block === block && !l.label ? i : -1)).filter((i) => i >= 0);
				this.visual = { anchor: idx[0], cursor: idx[idx.length - 1] };
				return;
			}
			case "visual.yank": {
				const lines = this.buildPaneLines(this.paneWidth());
				const [a, b] = [Math.min(this.visual.anchor, this.visual.cursor), Math.max(this.visual.anchor, this.visual.cursor)];
				this.yank(lines.slice(a, b + 1).map((l) => l.plain).join("\n"), b - a + 1);
				this.mode = "NORMAL";
				return;
			}
			case "message.next":
			case "message.prev":
				return this.jumpMessage(name === "message.next" ? 1 : -1);
			case "yank.reply": {
				const reply = [...(this.focusedSession?.items ?? [])].reverse().find((i) => i.kind === "agent" && i.text);
				if (!reply) this.setMessage("no reply to yank yet", "WarningMsg");
				else this.yank(reply.text, reply.text.split("\n").length);
				return;
			}
			case "yank.block": {
				const lines = this.buildPaneLines(this.paneWidth());
				const { start, end } = this.viewRange(lines.length);
				let block: number | undefined;
				for (let i = end - 1; i >= 0 && block === undefined; i--) if (lines[i].block !== undefined && i >= start - 1) block = lines[i].block;
				if (block === undefined) for (let i = lines.length - 1; i >= 0 && block === undefined; i--) block = lines[i].block;
				if (block === undefined) {
					this.setMessage("no code block to yank", "WarningMsg");
					return;
				}
				const code = lines.filter((l) => l.block === block && !l.label).map((l) => l.plain.replace(/^ {2,4}/, ""));
				this.yank(code.join("\n"), code.length);
				return;
			}
			case "scroll.down":
				return this.scrollBy(-1);
			case "scroll.up":
				return this.scrollBy(1);
			case "scroll.half_down":
				return this.scrollBy(-half);
			case "scroll.half_up":
				return this.scrollBy(half);
			case "scroll.page_down":
				return this.scrollBy(-page);
			case "scroll.page_up":
				return this.scrollBy(page);
			case "scroll.top":
				return this.scrollTop();
			case "scroll.bottom":
				this.scrollOffset = 0;
				return;
			case "session.next":
				if (count > 0) this.focusSession((this.focusIdx + 1) % count);
				return;
			case "session.prev":
				if (count > 0) this.focusSession((this.focusIdx - 1 + count) % count);
				return;
			case "session.alternate":
				return this.focusSession(this.altIdx);
			case "session.goto": {
				const n = Number(arg);
				if (!Number.isInteger(n) || n < 1) this.setMessage(`session.goto needs a number, got '${arg ?? ""}'`, "ErrorMsg");
				else this.focusSession(n - 1);
				return;
			}
			case "session.new":
				return this.exec("new");
			case "session.kill": {
				const s = this.focusedSession;
				if (!s) return;
				const keep = s.worktree?.path ? " (its worktree is kept)" : "";
				return this.ask(`Kill '${s.name}'${keep}? [y/N]`, () => this.exec("kill"));
			}
			case "session.pause":
				return this.exec("pause");
			case "session.resume":
				return this.exec("resume");
			case "session.abort": {
				const s = this.focusedSession;
				if (s?.state === "running") {
					s.abort();
					this.setMessage(`stopped '${s.name}'`, "WarningMsg");
				}
				return;
			}
			case "fold.toggle":
				return this.focusedSession?.toggleFolds();
			case "fold.open_all":
				return this.setAllFolds(false);
			case "fold.close_all":
				return this.setAllFolds(true);
			case "search.next":
				return this.gotoMatch(1);
			case "search.prev":
				return this.gotoMatch(-1);
			case "search.clear":
				return this.clearSearch();
			case "edit.submit":
				return this.submit();
			case "edit.backspace":
				if (this.mode === "INSERT") {
					this.inputBuf = this.inputBuf.slice(0, -1);
				} else if (this.cmdBuf.length === 0) {
					this.mode = "NORMAL"; // vim: backspace on an empty command line leaves it
				} else {
					this.cmdBuf = this.cmdBuf.slice(0, -1);
				}
				return;
			case "edit.delete_word":
				if (this.mode === "INSERT") this.inputBuf = this.inputBuf.replace(/\S*\s*$/, "");
				else this.cmdBuf = this.cmdBuf.replace(/\S*\s*$/, "");
				return;
			case "edit.clear":
				if (this.mode === "INSERT") this.inputBuf = "";
				else this.cmdBuf = "";
				return;
			case "theme.picker":
				return this.openThemePicker();
			case "app.help":
				return this.openHelp();
			case "app.redraw":
				return this.repaint();
			case "app.quit":
				return this.exec("qa");
			case "app.quit_force":
				return this.onQuit();
			case "app.dashboard":
				return this.openDashboard();
			case "session.tree":
				return this.openTree();
			case "app.quit_hint":
				this.setMessage("Type  :q  and press <Enter> to exit vigent", "Comment");
				return;
			case "noop":
				return;
			default:
				this.setMessage(`unknown action '${name}'`, "ErrorMsg");
		}
	}

	private submit() {
		if (this.mode === "INSERT") {
			const text = this.inputBuf.trim();
			this.inputBuf = "";
			this.mode = "NORMAL";
			const s = this.focusedSession;
			if (text && s) {
				const waiting = s.submit(text);
				if (waiting > 0) this.setMessage(`queued: '${s.name}' gets it after the current run (${waiting} waiting)`, "Comment");
				this.scrollOffset = 0;
			}
		} else if (this.mode === "COMMAND") {
			const cmd = this.cmdBuf;
			this.cmdBuf = "";
			this.mode = "NORMAL";
			this.exec(cmd);
		} else if (this.mode === "SEARCH") {
			this.searchQuery = this.cmdBuf;
			this.cmdBuf = "";
			this.mode = "NORMAL";
			this.runSearch();
		}
	}

	// ------------------------------------------------------------------ ex commands

	private exec(input: string) {
		const parsed = /^\s*(\S*)\s*([\s\S]*)$/.exec(input) ?? ["", "", ""];
		const cmd = parsed[1];
		// mappings keep trailing whitespace (":nmap x :new " opens ":new "), like vim
		const rawArg = parsed[2];
		const arg = rawArg.trim();
		switch (cmd) {
			case "":
				return;
			case "q":
			case "qa":
			case "quit":
			case "qall":
			case "x":
			case "xa": {
				const running = this.sessions.filter((x) => x.state === "running").length;
				if (running > 0) {
					this.setMessage(
						`E37: ${running} agent${running === 1 ? " is" : "s are"} still running (add ! to quit anyway)`,
						"ErrorMsg",
					);
					return;
				}
				this.onQuit();
				return;
			}
			case "q!":
			case "qa!":
			case "quit!":
			case "qall!":
				this.onQuit();
				return;
			case "queue":
				this.execQueue(rawArg.trimStart());
				return;
			case "pause":
			case "resume": {
				const s = this.focusedSession;
				if (!s) return;
				if (cmd === "pause") {
					s.pause();
					this.setMessage(`paused '${s.name}'${s.queue.length ? ` (${s.queue.length} queued)` : ""} · :resume to continue`, "WarningMsg");
				} else if (s.state !== "paused") {
					this.setMessage(`'${s.name}' isn't paused`, "Comment");
				} else {
					s.resume();
					this.message = "";
				}
				return;
			}
			case "merge":
				this.execMerge(arg);
				return;
			case "pr":
				this.execPr();
				return;
			case "dash":
			case "dashboard":
				this.openDashboard();
				return;
			case "tree":
				this.openTree();
				return;
			case "w":
			case "w!":
			case "write":
			case "write!":
				this.execWrite(arg, cmd.endsWith("!"));
				return;
			case "new":
			case "new!": {
				const modelFlag = /(?:^|\s)--model[= ](\S+)/.exec(arg);
				const name = arg.replace(/(?:^|\s)--model[= ]\S+/, "").trim() || `agent-${this.sessions.length + 1}`;
				try {
					const s = this.newSession(name, {
						worktree: cmd === "new" && this.workspace.config.enabled,
						model: modelFlag?.[1],
					});
					this.addSession(s);
					const wt = s.worktree;
					if (wt?.path) {
						this.setMessage(`'${name}' on ${wt.branch} in ${this.shortPath(wt.path)}${wt.base ? ` (from ${wt.base})` : ""}`, "ModeMsg");
					} else if (wt) {
						this.setMessage(`'${name}' on ${wt.branch}`, "ModeMsg");
					} else {
						const why = cmd === "new!" || !this.workspace.config.enabled ? "" : " (not a git repo, so no worktree)";
						this.setMessage(`'${name}' in this checkout${why}`, "ModeMsg");
					}
				} catch (err: any) {
					this.setMessage(String(err?.message ?? err), "ErrorMsg");
				}
				return;
			}
			case "kill":
			case "kill!":
				this.killFocused(cmd === "kill!");
				return;
			case "diff":
				this.openDiff(/^(split|vert|vertical|side)$/.test(arg));
				return;
			case "worktrees":
			case "worktree":
			case "wt":
				this.execWorktree(arg);
				return;
			case "attach":
				this.execAttach(arg);
				return;
			case "colorscheme":
			case "colo":
			case "theme": {
				if (!arg) {
					this.openThemePicker();
					return;
				}
				try {
					this.setTheme(loadTheme(arg));
					this.setMessage(`colorscheme ${this.painter.theme.name}`, "ModeMsg");
				} catch (err) {
					this.setMessage((err as Error).message, "ErrorMsg");
				}
				return;
			}
			case "hi":
			case "highlight":
			case "hi!":
			case "highlight!":
				this.execHighlight(arg);
				return;
			case "set":
			case "se": {
				const r = applySetCommand(this.ui, arg);
				this.applyColorMode();
				this.setMessage(r.message, r.error ? "ErrorMsg" : "Normal");
				this.repaint();
				return;
			}
			case "model": {
				if (this.focusedSession && arg) {
					this.focusedSession.model = arg;
					this.setMessage(`model set to '${arg}'`, "ModeMsg");
				}
				return;
			}
			case "help":
			case "h":
				this.openHelp();
				return;
			case "let":
				this.execLet(arg);
				return;
			default: {
				const map = /^([nicvx]?)(?:nore)?map$/.exec(cmd);
				if (map) return this.execMap(map[1], rawArg);
				const unmap = /^([nicvx]?)unmap$/.exec(cmd);
				if (unmap) return this.execUnmap(unmap[1], arg);
				this.setMessage(`E492: Not an editor command: ${cmd}`, "ErrorMsg");
			}
		}
	}

	private setMessage(text: string, group: string) {
		this.message = text;
		this.messageGroup = group;
	}

	// ---------------------------------------------------------------- review flow

	/** `:queue <prompt>` sends it after the current run; `:queue` lists what's waiting. */
	private execQueue(text: string) {
		const s = this.focusedSession;
		if (!s) {
			this.setMessage("no agent (:new <task> starts one)", "ErrorMsg");
			return;
		}
		if (!text.trim()) {
			if (s.queue.length === 0) {
				this.setMessage(`nothing queued for '${s.name}'`, "Comment");
				return;
			}
			const lines: FloatLine[] = s.queue.map((q, i) => [
				["LineNr", `${String(i + 1).padStart(2)} `],
				["NormalFloat", q],
			]);
			this.openFloat(`Queued for ${s.name}`, lines, 80);
			return;
		}
		const waiting = s.submit(text.trim());
		this.setMessage(waiting > 0 ? `queued for '${s.name}' (${waiting} waiting)` : `sent to '${s.name}'`, "Comment");
	}

	/** `:merge` squash-merges the agent's branch into its base in your checkout (`:merge --no-squash` merges). */
	private execMerge(arg: string) {
		const s = this.focusedSession;
		const wt = s?.worktree;
		if (!s || !wt?.path || !this.workspace.root) {
			this.setMessage(s ? `'${s.name}' has no worktree to merge` : "no agent", "ErrorMsg");
			return;
		}
		if (s.state === "running") {
			this.setMessage(`'${s.name}' is still running; wait for it or :pause it first`, "ErrorMsg");
			return;
		}
		const r = mergeWorktree(this.workspace.root, wt, { squash: !/--no-squash\b/.test(arg) });
		this.setMessage(r.ok ? `${r.message} · :kill! cleans up the worktree` : r.message, r.ok ? "ModeMsg" : "ErrorMsg");
		s.refreshStat(0);
	}

	/** `:pr` pushes the agent's branch and opens a pull request. */
	private execPr() {
		const s = this.focusedSession;
		const wt = s?.worktree;
		if (!s || !wt?.path || !this.workspace.root) {
			this.setMessage(s ? `'${s.name}' has no worktree to open a PR from` : "no agent", "ErrorMsg");
			return;
		}
		if (s.state === "running") {
			this.setMessage(`'${s.name}' is still running; wait for it or :pause it first`, "ErrorMsg");
			return;
		}
		this.setMessage(`pushing ${wt.branch}…`, "Comment");
		this.tui.requestRender();
		const r = openPullRequest(this.workspace.root, wt);
		this.setMessage(r.message, r.ok ? "ModeMsg" : "ErrorMsg");
	}

	/** `:w [file]`: the transcript as Markdown (`:w!` overwrites). */
	private execWrite(arg: string, force: boolean) {
		const s = this.focusedSession;
		if (!s) {
			this.setMessage("E32: No agent to write", "ErrorMsg");
			return;
		}
		const file = path.resolve(arg || `${slugifyName(s.name)}.md`);
		if (fs.existsSync(file) && !force) {
			this.setMessage(`E13: File exists (add ! to override): ${this.shortPath(file)}`, "ErrorMsg");
			return;
		}
		const md = transcriptMarkdown(s);
		try {
			fs.writeFileSync(file, md);
		} catch (err) {
			this.setMessage(`E212: Can't open file for writing: ${(err as Error).message}`, "ErrorMsg");
			return;
		}
		this.setMessage(`"${this.shortPath(file)}" ${md.split("\n").length - 1}L, ${Buffer.byteLength(md)}B written`, "Normal");
	}

	/** `:tree`: the conversation with every branch; Enter goes back to a point. */
	openTree() {
		const s = this.focusedSession;
		if (!s) {
			this.setMessage("no agent (:new <task> starts one)", "ErrorMsg");
			return;
		}
		const rows = s.tree(TREE_GLYPHS[this.ui.icons]);
		if (!rows) {
			this.setMessage(`'${s.name}' has no conversation tree (demo agents don't keep one)`, "Comment");
			return;
		}
		if (rows.length === 0) {
			this.setMessage(`nothing in '${s.name}' yet`, "Comment");
			return;
		}
		const I = this.icons;
		const kindGlyph: Record<TreeRow["kind"], [string, string]> = {
			user: ["VigentUser", I.prompt],
			agent: ["Normal", ""],
			tool: ["VigentTool", `${I.folded} `],
			summary: ["Special", "≈ "],
			note: ["NonText", "… "],
		};
		// every ├─ is one more alternative next to the └─ that ends its fork
		const branches = 1 + rows.filter((r) => r.guide.endsWith(TREE_GLYPHS[this.ui.icons].tee)).length;
		const lines: FloatLine[] = rows.map((r) => {
			const [g, glyph] = kindGlyph[r.kind];
			const textGroup = r.current ? "Title" : r.onPath ? (r.kind === "tool" ? "VigentTool" : "NormalFloat") : "Comment";
			return [
				["NonText", r.guide],
				[r.onPath ? g : "Comment", glyph],
				[textGroup, r.text],
				["String", r.current ? `  ${I.here} here` : ""],
				["Special", r.label ? `  [${r.label}]` : ""],
			];
		});
		const here = rows.findIndex((r) => r.current);
		const prompts = rows.filter((r) => r.kind === "user").length;
		const summary = `${prompts} prompt${prompts === 1 ? "" : "s"} · ${branches > 1 ? `${branches} branches` : "no branches yet"}`;
		this.openFloat(`Tree · ${s.name} · ${summary} · Enter: go back to that point`, lines, Math.min(110, this.terminal.columns - 4), {
			selectable: rows.map((_, i) => i),
			initial: here >= 0 ? here : rows.length - 1,
			onSelect: (i) => this.goToTreeNode(s, rows[i]),
		});
	}

	private goToTreeNode(s: Session, row: TreeRow) {
		if (row.current) return;
		s.navigate(row.id)
			.then(({ editorText }) => {
				this.scrollOffset = 0;
				this.invalidate();
				if (editorText !== undefined) {
					this.mode = "INSERT";
					this.inputBuf = editorText;
					this.setMessage("editing an earlier prompt · Enter sends it as a new branch (the old one stays in :tree)", "Comment");
				} else {
					this.setMessage("back at an earlier point · your next prompt starts a new branch (the old one stays in :tree)", "Comment");
				}
				this.tui.requestRender(true);
			})
			.catch((err) => {
				this.setMessage((err as Error).message, "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/** `:dash`: every agent at a glance; Enter jumps to one. */
	openDashboard() {
		if (this.sessions.length === 0) {
			this.setMessage("no agents yet (:new <task> starts one)", "Comment");
			return;
		}
		const I = this.icons;
		const lines: FloatLine[] = [];
		const rows: number[] = [];
		const stateGroup = (st: string) =>
			st === "running" ? "String" : st === "waiting" ? "WarningMsg" : st === "error" ? "ErrorMsg" : "Comment";
		this.sessions.forEach((s, i) => {
			const st = s.worktree?.stat;
			const glyph = s.state === "running" ? this.spinner() : I.state[s.state];
			const last = [...s.items].reverse().find((x) => x.kind === "agent" || x.kind === "user");
			const stat: [string, string][] = st && (st.added || st.removed)
				? [["Added", ` +${st.added}`], ["Removed", ` ${I.minus}${st.removed}`]]
				: [["Comment", ""]];
			rows.push(lines.length);
			lines.push([
				["LineNr", `${String(i + 1).padStart(2)} `],
				[stateGroup(s.state), `${glyph} `],
				["Title", truncateToWidth(s.name, 26, "…").padEnd(27)],
				[stateGroup(s.state), s.state.padEnd(8)],
				["Comment", ` ${truncateToWidth(s.worktree ? `${I.worktree}${s.worktree.branch}` : s.model, 34, "…")}`],
				...stat,
				["Comment", s.queue.length ? `  ${I.queued}${s.queue.length}` : ""],
			]);
			lines.push([
				["NormalFloat", "      "],
				["Comment", last ? truncateToWidth(plainPreview(last.text), 90, "…") : "(no messages yet)"],
			]);
		});
		const running = this.sessions.filter((s) => s.state === "running").length;
		lines.push([]);
		lines.push([["Comment", `${this.sessions.length} agents · ${running} running · j/k move · Enter open`]]);
		this.openFloat("Dashboard", lines, Math.min(110, this.terminal.columns - 4), {
			selectable: rows,
			onSelect: (lineIdx) => this.focusSession(rows.indexOf(lineIdx)),
			initial: rows[this.focusIdx],
		});
	}

	// ---------------------------------------------------------------- visual & yank

	/** First and last+1 pane lines on screen. */
	private viewRange(total: number): { start: number; end: number } {
		const h = this.contentHeight();
		const start = Math.max(0, total - h - this.scrollOffset);
		return { start, end: Math.min(total, start + h) };
	}

	/** Scroll just enough to show a pane line. */
	private revealLine(idx: number) {
		const total = this.buildPaneLines(this.paneWidth()).length;
		const h = this.contentHeight();
		const { start, end } = this.viewRange(total);
		if (idx < start) this.scrollOffset = Math.max(0, total - h - idx);
		else if (idx >= end) this.scrollOffset = Math.max(0, total - idx - 1);
	}

	private moveCursor(delta: number) {
		const total = this.buildPaneLines(this.paneWidth()).length;
		this.visual.cursor = Math.max(0, Math.min(total - 1, this.visual.cursor + delta));
		this.revealLine(this.visual.cursor);
	}

	private yank(text: string, lineCount: number) {
		const how = this.clipboard(text);
		this.setMessage(`${lineCount} line${lineCount === 1 ? "" : "s"} yanked${how === "terminal" ? "" : ` (${how})`}`, "Normal");
	}

	/** `{` / `}`: put the previous / next message at the top of the pane. */
	private jumpMessage(dir: 1 | -1) {
		const lines = this.buildPaneLines(this.paneWidth());
		const { start } = this.viewRange(lines.length);
		const starts = lines.map((l, i) => (l.start ? i : -1)).filter((i) => i >= 0);
		const target = dir > 0 ? starts.find((i) => i > start) : [...starts].reverse().find((i) => i < start);
		if (target === undefined) {
			if (dir > 0) this.scrollOffset = 0;
			else this.scrollTop();
			return;
		}
		const h = this.contentHeight();
		this.scrollOffset = Math.max(0, Math.min(Math.max(0, lines.length - h), lines.length - h - target));
	}

	private shortPath(p: string): string {
		const rel = path.relative(process.cwd(), p);
		return rel && !rel.startsWith(`..${path.sep}..`) ? rel : p;
	}

	/** `:kill` stops the agent and keeps its worktree; `:kill!` also removes it (git's safe remove). */
	private killFocused(removeTree: boolean) {
		const s = this.focusedSession;
		if (!s) return;
		s.abort();
		s.dispose();
		this.sessions.splice(this.focusIdx, 1);
		this.focusIdx = Math.max(0, Math.min(this.focusIdx, this.sessions.length - 1));
		const wt = s.worktree;
		if (!wt?.path || !this.workspace.root) {
			this.setMessage(`killed '${s.name}'`, "WarningMsg");
			return;
		}
		if (!removeTree) {
			try {
				setDetached(wt.path, true); // not reopened at the next start; :attach brings it back
			} catch {
				// the worktree may already be gone
			}
			this.setMessage(`killed '${s.name}' · kept ${wt.branch} (:attach ${wt.branch} reopens it, :worktree remove deletes it)`, "WarningMsg");
			return;
		}
		const r = removeWorktree(this.workspace.root, { path: wt.path, branch: wt.branch, base: wt.base });
		this.setMessage(`killed '${s.name}' · ${r.message}`, r.removed ? "WarningMsg" : "ErrorMsg");
	}

	/** `:attach <branch>` reopens an agent in one of the worktrees listed by :worktrees. */
	private execAttach(arg: string) {
		const root = this.workspace.root;
		if (!root) {
			this.setMessage("not in a git repository", "ErrorMsg");
			return;
		}
		if (!arg) {
			this.setMessage("usage: :attach <branch>  (see :worktrees)", "Comment");
			return;
		}
		const w = findWorktree(root, arg, this.workspace.config);
		if (!w?.branch) {
			this.setMessage(`no worktree '${arg}' (see :worktrees)`, "ErrorMsg");
			return;
		}
		const owner = this.sessions.findIndex((s) => s.worktree?.path === w.path);
		if (owner >= 0) {
			this.focusSession(owner);
			return;
		}
		try {
			const s = this.attachSession({ branch: w.branch, path: w.path });
			this.addSession(s);
			this.setMessage(`attached '${s.name}' to ${w.branch}`, "ModeMsg");
		} catch (err) {
			this.setMessage((err as Error).message, "ErrorMsg");
		}
	}

	/** `:worktrees` lists them; `:worktree remove[!] <branch>` deletes one. */
	private execWorktree(arg: string) {
		const root = this.workspace.root;
		if (!root) {
			this.setMessage("not in a git repository", "ErrorMsg");
			return;
		}
		const m = /^(remove|rm)(!?)\s+(\S+)$/.exec(arg);
		if (m) {
			const w = findWorktree(root, m[3], this.workspace.config);
			if (!w) {
				this.setMessage(`no worktree '${m[3]}' (see :worktrees)`, "ErrorMsg");
				return;
			}
			const owner = this.sessions.find((s) => s.worktree?.path === w.path);
			if (owner) {
				this.setMessage(`'${owner.name}' is working in ${w.branch}; stop it first (:kill or :kill!)`, "ErrorMsg");
				return;
			}
			const r = removeWorktree(root, w, m[2] === "!");
			this.setMessage(r.message, r.removed ? "WarningMsg" : "ErrorMsg");
			return;
		}
		if (arg) {
			this.setMessage("usage: :worktrees  |  :worktree remove[!] <branch>", "Comment");
			return;
		}
		let all: ReturnType<typeof listWorktrees>;
		try {
			all = listWorktrees(root, this.workspace.config);
		} catch (err) {
			this.setMessage((err as Error).message, "ErrorMsg");
			return;
		}
		if (all.length === 0) {
			this.setMessage("no agent worktrees yet (:new <task> creates one)", "Comment");
			return;
		}
		const lines: FloatLine[] = all.map((w) => {
			const owner = this.sessions.find((s) => s.worktree?.path === w.path);
			return [
				[owner ? "String" : "Comment", owner ? "● " : "  "],
				["Title", `${(w.branch ?? `(detached ${w.head})`).padEnd(30)} `],
				["NormalFloat", `${truncateToWidth(owner?.name ?? "", 20, "…").padEnd(20)} `],
				["Comment", this.shortPath(w.path)],
			];
		});
		lines.push([]);
		lines.push([["Comment", "● = an agent is working in it · :attach <branch> reopens one · :worktree remove <branch> deletes it"]]);
		this.openFloat("Worktrees", lines, 96);
	}

	/** `:diff`: what the focused agent changed since its worktree was created. */
	private openDiff(split = false) {
		const s = this.focusedSession;
		const wt = s?.worktree;
		if (!s || !wt?.path) {
			this.setMessage(s ? `'${s.name}' has no worktree to diff` : "no agent", "ErrorMsg");
			return;
		}
		diffText(wt)
			.then((text) => {
				if (!text.trim()) {
					this.setMessage(`no changes on ${wt.branch} yet`, "Comment");
					this.tui.requestRender();
					return;
				}
				const width = this.terminal.columns - 4;
				const unified = unifiedView(text);
				const side = splitView(text, width - 3);
				const n = unified.jumps.length;
				const title = (layout: string) =>
					`${wt.branch} vs ${wt.base ?? "base"} · ${n} hunk${n === 1 ? "" : "s"} · ]c [c jump · s ${layout}`;
				const views = [
					{ title: title("side by side"), lines: unified.lines, jumps: unified.jumps },
					{ title: title("unified"), lines: side.lines, jumps: side.jumps },
				];
				const [first, second] = split ? [views[1], views[0]] : views;
				this.openFloat(first.title, first.lines, width, { jumps: first.jumps, alternate: second });
			})
			.catch((err) => {
				this.setMessage(`git diff failed: ${(err as Error).message.split("\n")[0]}`, "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/** `:map`, `:nmap`, `:inoremap`, ... (all mappings are non-recursive, like noremap). */
	private execMap(letter: string, arg: string) {
		const modes = mapModes(letter);
		const m = /^(\S+)(?:\s+([\s\S]*\S[\s\S]*))?\s*$/.exec(arg.trimStart());
		if (!m) {
			this.openMappings(modes);
			return;
		}
		const [, lhs, rhs] = m;
		if (rhs === undefined) {
			const found = modes.flatMap((mode) => {
				try {
					const b = this.keymap.lookup(mode, parseKeys(lhs, this.keymap.leader)).exact;
					return b ? [`${MODE_LETTER[mode]}  ${formatKeys(b.keys)}  ${b.rhsText}`] : [];
				} catch {
					return [];
				}
			});
			this.setMessage(found.length > 0 ? found.join("   ") : "No mapping found", found.length > 0 ? "Normal" : "Comment");
			return;
		}
		try {
			for (const mode of modes) this.keymap.set(mode, lhs, rhs);
			this.message = "";
		} catch (err) {
			this.setMessage(`E474: ${(err as Error).message}`, "ErrorMsg");
		}
	}

	private execUnmap(letter: string, arg: string) {
		const lhs = arg.trim();
		if (!lhs) {
			this.setMessage("E474: Invalid argument", "ErrorMsg");
			return;
		}
		try {
			const removed = mapModes(letter).map((mode) => this.keymap.unset(mode, lhs)).some(Boolean);
			if (!removed) this.setMessage("E31: No such mapping", "ErrorMsg");
		} catch (err) {
			this.setMessage(`E474: ${(err as Error).message}`, "ErrorMsg");
		}
	}

	/** `:let mapleader = ","` (affects mappings defined after it, like vim). */
	private execLet(arg: string) {
		const m = /^(?:g:)?mapleader\s*=\s*(["'])(.*)\1$/.exec(arg.trim());
		if (!m) {
			this.setMessage("only  :let mapleader = \"<key>\"  is supported", "Comment");
			return;
		}
		try {
			parseKeys(m[2]);
			this.keymap.leader = m[2];
		} catch {
			this.setMessage(`E474: leader '${m[2]}' is not a key`, "ErrorMsg");
		}
	}

	private openFloat(title: string, lines: FloatLine[], width: number, opts: FloatOptions = {}) {
		this.seq.reset();
		let handle: { hide(): void } | undefined;
		const float = new TextFloat(
			this.painter,
			PICKER_ICONS[this.ui.icons],
			title,
			lines,
			() => this.terminal.rows - 4,
			() => {
				handle?.hide();
				this.repaint();
			},
			() => this.tui.requestRender(),
			opts,
		);
		handle = this.tui.showOverlay(float, { width: Math.min(width, this.terminal.columns - 4), anchor: "center" });
		this.tui.requestRender();
	}

	/** `:map` with no arguments: list your mappings, vim-style. */
	private openMappings(modes: KeyMode[]) {
		const lines: FloatLine[] = [];
		for (const mode of modes) {
			for (const b of this.keymap.bindings(mode).filter((x) => x.user)) {
				lines.push([
					["Comment", `${MODE_LETTER[mode]}  `],
					["Title", formatKeys(b.keys).padEnd(14)],
					["NormalFloat", ` ${b.rhsText}`],
				]);
			}
		}
		if (lines.length === 0) {
			this.setMessage("No mapping found", "Comment");
			return;
		}
		this.openFloat("Mappings", lines, 72);
	}

	/** `:help`: every active key, generated from the keymap so it shows your mappings. */
	openHelp() {
		const lines: FloatLine[] = [];
		const labels: Record<KeyMode, string> = { normal: "NORMAL", insert: "INSERT", visual: "VISUAL", command: "COMMAND LINE" };
		for (const mode of KEY_MODES) {
			if (lines.length > 0) lines.push([]);
			lines.push([["Title", labels[mode]]]);
			const groups = new Map<string, { keys: { text: string; user: boolean }[]; desc: string; user: boolean }>();
			for (const b of this.keymap.bindings(mode)) {
				const first = b.rhs[0];
				const single = b.rhs.length === 1 && first.kind === "action";
				const groupKey = single && first.name === "session.goto" ? "session.goto" : b.rhsText;
				const desc = single && first.name === "session.goto" ? "jump to session N" : describeRhs(b.rhs);
				const g = groups.get(groupKey) ?? { keys: [], desc, user: false };
				g.keys.push({ text: formatKeys(b.keys), user: b.user });
				g.user ||= b.user;
				groups.set(groupKey, g);
			}
			// your mappings first
			const ordered = [...groups.values()].sort((a, b) => Number(b.user) - Number(a.user));
			for (const g of ordered) {
				const texts = g.keys.map((k) => k.text);
				const keySegs: [string, string][] =
					g.keys.length > 4 && groupKeyIsDigits(texts)
						? [["Identifier", `${texts[0]}-${texts[texts.length - 1]}`]]
						: g.keys.map((k, i) => [k.user ? "String" : "Identifier", (i > 0 ? " " : "") + k.text]);
				const width = keySegs.reduce((n, [, t]) => n + visibleWidth(t), 0);
				lines.push([
					[g.user ? "String" : "Comment", g.user ? "* " : "  "],
					...keySegs,
					["NormalFloat", " ".repeat(Math.max(1, 17 - width)) + g.desc],
				]);
			}
		}
		lines.push([]);
		lines.push([["Title", "COMMANDS"]]);
		for (const [c, d] of EX_HELP) lines.push([["Comment", "  "], ["Identifier", c.padEnd(29)], ["NormalFloat", d]]);
		lines.push([]);
		lines.push([["Comment", `* = your mapping · leader = ${this.keymap.leader === " " ? "<Space>" : this.keymap.leader}`]]);
		this.openFloat("Keys", lines, 76);
	}

	private execHighlight(arg: string) {
		const P = this.painter;
		const cmd = parseHighlightCommand(arg);
		if (!cmd) {
			this.setMessage("usage: :hi Group guifg=#rrggbb guibg=#rrggbb gui=bold | :hi link A B | :hi clear", "Comment");
			return;
		}
		switch (cmd.kind) {
			case "show": {
				const a = P.attr(cmd.group);
				this.message = `${cmd.group} ${sgr(a)}xxx${RESET}${P.s("Normal")} ${describeAttr(a)}`;
				this.messageGroup = "Normal";
				return;
			}
			case "set":
				P.highlight(cmd.group, cmd.attr);
				break;
			case "link":
				P.link(cmd.from, cmd.to);
				break;
			case "clear":
				P.clear(cmd.group);
				break;
		}
		this.message = "";
		this.repaint();
	}

	/** `:colorscheme` with no argument: floating picker with live preview. */
	openThemePicker() {
		this.seq.reset();
		const original = this.painter.theme;
		const themes = listThemes();
		const preview = (name: string) => {
			try {
				this.painter.setTheme(loadTheme(name));
				this.invalidate();
				this.message = "";
			} catch (err) {
				this.setMessage((err as Error).message, "ErrorMsg");
			}
			this.tui.requestRender(true);
		};
		let handle: { hide(): void } | undefined;
		const picker = new ThemePicker(
			this.painter,
			themes,
			original.name,
			PICKER_ICONS[this.ui.icons],
			preview,
			(name) => {
				handle?.hide();
				if (name) {
					preview(name);
					this.setMessage(`colorscheme ${name}`, "ModeMsg");
				} else {
					this.painter.setTheme(original);
				}
				this.repaint();
			},
			() => this.tui.requestRender(),
		);
		handle = this.tui.showOverlay(picker, { width: 40, anchor: "center" });
		this.tui.requestRender();
	}

	// ------------------------------------------------------------------ scroll & search

	/** transcript rows: the screen minus winbar, statusline and command line */
	private contentHeight(): number {
		return Math.max(1, this.terminal.rows - 3);
	}

	private scrollBy(delta: number) {
		const total = this.buildPaneLines(this.paneWidth()).length;
		const max = Math.max(0, total - this.contentHeight());
		this.scrollOffset = Math.max(0, Math.min(max, this.scrollOffset + delta));
	}

	private scrollTop() {
		const total = this.buildPaneLines(this.paneWidth()).length;
		this.scrollOffset = Math.max(0, total - this.contentHeight());
	}

	private setAllFolds(folded: boolean) {
		const s = this.focusedSession;
		if (!s) return;
		for (const i of s.items) if (i.tool) i.tool.folded = folded;
		(s as any).version++;
		this.paneCache.key = "";
	}

	private clearSearch() {
		this.searchQuery = "";
		this.matches = [];
		this.matchIdx = -1;
	}

	private runSearch() {
		const lines = this.buildPaneLines(this.paneWidth());
		const q = this.searchQuery.toLowerCase();
		this.matches = [];
		if (!q) return;
		lines.forEach((l, i) => {
			if (l.plain.toLowerCase().includes(q)) this.matches.push(i);
		});
		if (this.matches.length === 0) {
			this.setMessage(`E486: Pattern not found: ${this.searchQuery}`, "ErrorMsg");
			this.matchIdx = -1;
			return;
		}
		this.matchIdx = this.matches.length - 1;
		this.scrollToLine(this.matches[this.matchIdx]);
		this.announceMatch();
	}

	private gotoMatch(dir: 1 | -1) {
		if (this.matches.length === 0) {
			if (this.searchQuery) this.setMessage(`E486: Pattern not found: ${this.searchQuery}`, "ErrorMsg");
			return;
		}
		const step = this.searchBackward ? -dir : dir;
		this.matchIdx = (this.matchIdx + step + this.matches.length) % this.matches.length;
		this.scrollToLine(this.matches[this.matchIdx]);
		this.announceMatch();
	}

	private announceMatch() {
		const prefix = this.searchBackward ? "?" : "/";
		this.setMessage(`${prefix}${this.searchQuery}  match ${this.matchIdx + 1}/${this.matches.length}`, "Search");
	}

	private scrollToLine(lineIdx: number) {
		const total = this.buildPaneLines(this.paneWidth()).length;
		const h = this.contentHeight();
		const desired = total - lineIdx - Math.floor(h / 2);
		this.scrollOffset = Math.max(0, Math.min(Math.max(0, total - h), desired - 1));
	}

	// ------------------------------------------------------------------ rendering

	private sidebarWidth(width: number): number {
		return this.ui.sidebar && width >= this.ui.sidebar_width + 40 ? this.ui.sidebar_width : 0;
	}

	private paneWidth(): number {
		const width = this.terminal.columns;
		const sb = this.sidebarWidth(width);
		return Math.max(20, width - sb - (sb > 0 ? 1 : 0) - 2);
	}

	render(width: number): string[] {
		const P = this.painter;
		const sideH = Math.max(1, this.terminal.rows - 2);
		const paneH = this.contentHeight();
		const sbW = this.sidebarWidth(width);
		const paneW = this.paneWidth();

		const sidebar = sbW > 0 ? this.renderSidebar(sbW, sideH) : [];
		const intro = this.sessions.length === 0;
		const paneLines = intro ? this.introLines(paneW, paneH) : this.buildPaneLines(paneW);
		const { start } = intro ? { start: 0 } : this.viewRange(paneLines.length);
		const view = paneLines.slice(start, start + paneH);
		const [selA, selB] = [Math.min(this.visual.anchor, this.visual.cursor), Math.max(this.visual.anchor, this.visual.cursor)];
		const visualBg = P.attr("Visual").bg;

		const out: string[] = [];
		const sep = P.p("WinSeparator", this.icons.sep);
		const normalBg = P.s("Normal");
		for (let r = 0; r < sideH; r++) {
			const left = sbW > 0 ? sidebar[r] + sep : "";
			if (r === 0) {
				out.push(left + this.renderWinbar(paneW + 2));
				continue;
			}
			const vi = r - 1 - (paneH - view.length);
			const line = vi >= 0 ? view[vi] : undefined;
			const idx = start + vi;
			let text = line?.text ?? "";
			let bg = normalBg;
			if (line && this.mode === "VISUAL" && idx >= selA && idx <= selB) {
				// like nvim: the Visual background under the line's own colors
				bg = P.on("Normal", visualBg);
				text = bg + line.text.split(normalBg).join(bg);
			} else if (line && this.matches.includes(idx)) {
				text = P.s("Search") + line.plain;
			}
			const pad = Math.max(0, paneW + 2 - 1 - visibleWidth(line?.plain ?? ""));
			out.push(left + bg + " " + text + bg + " ".repeat(pad) + RESET);
		}
		out.push(this.renderStatusline(width));
		out.push(this.renderCmdline(width));
		return out.map((l) => truncateToWidth(l, width));
	}

	/** Neovim-style 'winbar' over the transcript: which agent, its model, where it works. */
	private renderWinbar(w: number): string {
		const P = this.painter;
		const bg = P.attr("WinBar").bg ?? P.attr("Normal").bg;
		const s = this.focusedSession;
		const left = s ? ` ${this.icons.open_agent} ${s.name}` : ` ${this.icons.open_agent} [no agent]`;
		const model = s ? `  ${s.model}` : "";
		const where = s?.worktree?.path ? this.shortPath(s.worktree.path) : s ? "this checkout" : "";
		const right = where ? `${where} ` : "";
		const room = Math.max(0, w - visibleWidth(left) - visibleWidth(model) - visibleWidth(right));
		const status = s?.state === "paused" ? "  paused" : s?.queue.length ? `  ${this.icons.queued}${s.queue.length} queued` : "";
		return (
			P.on("WinBar", bg) +
			left +
			RESET +
			P.on("Comment", bg) +
			model +
			P.on("WarningMsg", bg) +
			status +
			P.on("Normal", bg) +
			" ".repeat(Math.max(0, room - visibleWidth(status))) +
			P.on("Comment", bg) +
			right +
			RESET
		);
	}

	/** Shown when no agent is running, like Neovim's intro screen. */
	private introLines(paneW: number, paneH: number): PaneLine[] {
		const P = this.painter;
		const center = (plain: string) => " ".repeat(Math.max(0, Math.floor((paneW - visibleWidth(plain)) / 2)));
		const rows: { text: string; plain: string }[] = [];
		const add = (text: string, plain: string, indent = center(plain)) => rows.push({ text: indent + text, plain: indent + plain });
		const title = `VIGENT v${VERSION}`;
		add(P.p("Title", title), title);
		add("", "");
		for (const l of ["vim-native coding-agent orchestrator", "built on pi · every agent in its own git worktree"]) add(P.p("Comment", l), l);
		add("", "");
		const tips: [string, string][] = [
			[":new fix flaky test<Enter>", "start an agent"],
			[":colorscheme<Enter>", "pick a theme"],
			[":help<Enter>", "every key, yours included"],
			[":q<Enter>", "to exit"],
		];
		const cmdW = Math.max(...tips.map(([c]) => c.length));
		const blockW = 5 + cmdW + 2 + Math.max(...tips.map(([, d]) => d.length));
		const indent = center("x".repeat(blockW));
		for (const [c, d] of tips) {
			const plain = `type  ${c.padEnd(cmdW)}  ${d}`;
			add(P.p("Comment", "type  ") + P.p("Special", c.padEnd(cmdW)) + P.p("Comment", `  ${d}`), plain, indent);
		}
		if (!this.workspace.root) {
			add("", "");
			const note = "(not a git repository: agents will share this folder)";
			add(P.p("WarningMsg", note), note);
		}
		const top = Math.max(0, Math.floor((paneH - rows.length) / 2));
		const normal = P.s("Normal");
		const lines: PaneLine[] = rows.map((r) => ({ text: r.text.split(RESET).join(RESET + normal), plain: r.plain }));
		const bottom = Math.max(0, paneH - top - lines.length);
		return [...lines, ...Array.from({ length: bottom }, () => ({ text: "", plain: "" }))];
	}

	/**
	 * Neovim tree-style sidebar (neo-tree / nvim-tree look):
	 *   winbar header, number column (session index, used by 1-9),
	 *   tree guides, cursorline on the focused session, ~ filler rows.
	 */
	private renderSidebar(w: number, h: number): string[] {
		const P = this.painter;
		const base = P.attr("VigentSidebar");
		const bg = base.bg ?? P.attr("Normal").bg;
		const clBg = P.attr("CursorLine").bg ?? bg;
		const I = this.icons;
		const lines: string[] = [];

		// row = list of [group, text] segments drawn on one background, padded to w
		const row = (segs: [string, string][], rowBg = bg): string => {
			let out = "";
			let used = 0;
			for (const [group, text] of segs) {
				const t = truncateToWidth(text, Math.max(0, w - used), "…");
				out += RESET + P.on(group, rowBg) + t;
				used += visibleWidth(t);
			}
			return out + P.on("VigentSidebar", rowBg) + " ".repeat(Math.max(0, w - used)) + RESET;
		};

		// winbar
		const running = this.sessions.filter((x) => x.state === "running").length;
		const right = running > 0 ? `${running} running ` : `${this.sessions.length} `;
		const title = " SESSIONS";
		lines.push(
			row([
				["WinBar", title],
				["VigentSidebar", " ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(right)))],
				["Comment", right],
			]),
		);

		this.sessions.forEach((s, i) => {
			const last = i === this.sessions.length - 1;
			const focused = i === this.focusIdx;
			const rowBg = focused ? clBg : bg;
			const glyphGroup =
				s.state === "running"
					? "String"
					: s.state === "waiting"
						? "WarningMsg"
						: s.state === "error"
							? "ErrorMsg"
							: "Comment";
			const glyph = s.state === "running" ? this.spinner() : I.state[s.state];
			const num = this.ui.number ? `${String(i + 1).padStart(3)} ` : " ";
			lines.push(
				row(
					[
						[focused ? "CursorLineNr" : "LineNr", num],
						["VigentIndent", last ? I.last : I.tee],
						[glyphGroup, `${glyph} `],
						[focused ? "Title" : "VigentSidebar", s.name],
						["Comment", s.queue.length > 0 ? ` ${I.queued}${s.queue.length}` : ""],
					],
					rowBg,
				),
			);
			const model = s.model.replace(/^claude-/, "");
			const indent: [string, string][] = [
				["LineNr", " ".repeat(num.length)],
				["VigentIndent", last ? "  " : I.pipe],
			];
			if (s.worktree) {
				// the +/- counts matter more than the end of a long branch name
				const stat = this.statSegments(s.worktree.stat);
				const statWidth = stat.reduce((n, [, t]) => n + visibleWidth(t), 0);
				const room = w - num.length - 2 - 2 - visibleWidth(I.worktree) - statWidth;
				const branch = truncateToWidth(s.worktree.branch, Math.max(4, room), "…");
				lines.push(row([...indent, ["Comment", `  ${I.worktree}${branch}`], ...stat]));
			} else {
				lines.push(row([...indent, ["Comment", `  ${model}`]]));
			}
		});

		while (lines.length < h) lines.push(row([["EndOfBuffer", this.ui.tilde ? "~" : ""]]));
		return lines.slice(0, h);
	}

	/** " +41 −18" in the diff colors; nothing when there are no changes yet. */
	private statSegments(stat: DiffStat | undefined): [string, string][] {
		if (!stat || (stat.added === 0 && stat.removed === 0)) return [];
		return [
			["Added", ` +${stat.added}`],
			["Removed", ` ${this.icons.minus}${stat.removed}`],
		];
	}

	private buildPaneLines(paneW: number): PaneLine[] {
		const s = this.focusedSession;
		const key = `${s ? `${s.id}:${s.version}` : "empty"}:${paneW}:${this.painter.generation}:${this.ui.icons}`;
		if (this.paneCache.key === key) return this.paneCache.lines;

		const P = this.painter;
		const I = this.icons;
		const lines: PaneLine[] = [];
		const normal = P.s("Normal");
		// a RESET inside a line would drop the theme background; restore it after each one
		const push = (text: string, plain: string, meta: Omit<PaneLine, "text" | "plain"> = {}) =>
			lines.push({ text: text.split(RESET).join(RESET + normal), plain, ...meta });
		let nextBlock = 0;

		(s?.items ?? []).forEach((item, n) => {
			switch (item.kind) {
				case "user": {
					push("", "");
					wrapTextWithAnsi(item.text, paneW - 2).forEach((l, i) => {
						push(P.p("VigentUser", I.prompt) + P.s("Normal") + P.p("Keyword", l), I.prompt + stripAnsi(l), {
							item: n,
							start: i === 0,
						});
					});
					break;
				}
				case "agent": {
					push("", "");
					const text = item.text + (item.streaming ? ` ${I.cursor}` : "");
					const md = renderMarkdown(text, paneW, P, I.bullet, nextBlock);
					md.lines.forEach((l, i) =>
						push(P.s("Normal") + l.text + RESET, l.plain, { item: n, start: i === 0, block: l.block, label: l.label }),
					);
					nextBlock += md.blocks;
					break;
				}
				case "tool": {
					const t = item.tool!;
					const fold = t.folded ? I.folded : I.open;
					push(
						P.p("NonText", ` ${fold} `) + P.p("VigentTool", t.name) + P.p("Comment", ` ${t.summary}`),
						` ${fold} ${t.name} ${t.summary}`,
						{ item: n },
					);
					if (!t.folded && t.output) {
						const block = nextBlock++;
						const outLines = t.output.split("\n");
						for (const ol of outLines.slice(0, 12)) {
							for (const wl of wrapTextWithAnsi(ol, paneW - 4)) {
								push(`    ${P.p("VigentToolOutput", wl)}`, `    ${stripAnsi(wl)}`, { item: n, block });
							}
						}
						if (outLines.length > 12) {
							push(`    ${P.p("NonText", `… ${outLines.length - 12} more lines`)}`, `    … ${outLines.length - 12} more lines`, { item: n });
						}
					}
					break;
				}
				case "info": {
					push("", "");
					wrapTextWithAnsi(item.text, paneW).forEach((l, i) => push(P.p("Comment", l), stripAnsi(l), { item: n, start: i === 0 }));
					break;
				}
			}
		});
		this.paneCache = { lines, key };
		return lines;
	}

	private renderStatusline(width: number): string {
		const P = this.painter;
		const s = this.focusedSession;
		const modeBadge = P.p(MODE_GROUP[this.mode], ` ${this.mode} `);
		const running = this.sessions.filter((x) => x.state === "running").length;
		const leftText = s ? ` ${s.name} ` : " [no session] ";
		const st = s?.worktree?.stat;
		const changes = st && (st.added || st.removed) ? ` +${st.added} ${this.icons.minus}${st.removed}` : "";
		const worktree = s?.worktree ? `${this.icons.worktree}${s.worktree.branch}${changes} ` : "";
		const right = s
			? ` ${s.model}  ${formatTokens(s.tokens)}  ${running}/${this.sessions.length}${running > 0 ? ` ${this.spinner()}` : ""} `
			: "";
		const plainLen = visibleWidth(` ${this.mode} `) + visibleWidth(leftText) + visibleWidth(worktree) + visibleWidth(right);
		const fill = Math.max(0, width - plainLen);
		return (
			modeBadge +
			P.s("StatusLine") +
			leftText +
			P.s("StatusLineNC") +
			worktree +
			" ".repeat(Math.max(0, fill - (worktree ? 0 : 0))) +
			P.s("StatusLine") +
			right +
			RESET
		);
	}

	private renderCmdline(width: number): string {
		const P = this.painter;
		const bg = P.s("MsgArea") || P.s("Normal");
		let content: string;
		switch (this.confirm ? "CONFIRM" : this.mode) {
			case "CONFIRM":
				content = P.p("Question", this.confirm!.question) + P.s("Normal") + " " + P.p("PmenuSel", " ");
				break;
			case "COMMAND":
				content = P.s("Normal") + ":" + this.cmdBuf + P.p("PmenuSel", " ");
				break;
			case "SEARCH":
				content = P.s("Normal") + (this.searchBackward ? "?" : "/") + this.cmdBuf + P.p("PmenuSel", " ");
				break;
			case "VISUAL": {
				const n = Math.abs(this.visual.cursor - this.visual.anchor) + 1;
				content = P.p("ModeMsg", "-- VISUAL LINE --") + P.p("Comment", `  ${n} line${n === 1 ? "" : "s"} · y yank · ib code block · Esc cancel`);
				break;
			}
			case "INSERT":
				content =
					P.p("ModeMsg", "-- INSERT --") +
					P.s("Normal") +
					`  ${this.icons.prompt}` +
					this.inputBuf +
					P.p("Comment", formatKeys(this.seq.pendingKeys).replace(/<Space>/g, " ")) +
					P.p("PmenuSel", " ");
				break;
			default: {
				if (this.message) content = P.p(this.messageGroup, this.message);
				else content = P.p("NonText", `:help for keys`);
			}
		}
		// vim's 'showcmd': keys typed so far for a pending mapping, near the right edge
		const showcmd = this.mode === "INSERT" ? "" : formatKeys(this.seq.pendingKeys);
		const showWidth = showcmd ? Math.max(10, visibleWidth(showcmd) + 1) : 0;
		const pad = Math.max(0, width - visibleWidth(stripAnsi(content)) - showWidth);
		const right = showcmd ? P.s("Normal") + showcmd.padEnd(showWidth) : "";
		return bg + content + bg + " ".repeat(pad) + right + RESET;
	}
}

function stripAnsi(s: string): string {
	// biome-ignore lint: control chars intended
	return s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
}

const VERSION: string = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0";
	} catch {
		return "0";
	}
})();

const MODE_LETTER: Record<KeyMode, string> = { normal: "n", insert: "i", visual: "x", command: "c" };


function mapModes(letter: string): KeyMode[] {
	if (letter === "i") return ["insert"];
	if (letter === "c") return ["command"];
	if (letter === "x" || letter === "v") return ["visual"];
	return ["normal"];
}

function groupKeyIsDigits(keys: string[]): boolean {
	return keys.every((k) => /^\d$/.test(k));
}

function describeRhs(rhs: Rhs[]): string {
	return rhs
		.map((r) => {
			switch (r.kind) {
				case "action":
					return ACTIONS[r.name] + (r.arg ? ` (${r.arg})` : "");
				case "ex":
					return `:${r.cmd.trimEnd()}${r.execute ? "" : " …"}`;
				case "keys":
					return `same as ${formatKeys(r.keys)}`;
				case "nop":
					return "disabled";
			}
		})
		.join(", then ");
}

const EX_HELP: [string, string][] = [
	[":new [task]", "start an agent in its own worktree"],
	[":kill  /  :kill!", "stop the agent (keep / remove its worktree)"],
	[":new! [name]", "agent in this checkout, no worktree"],
	[":diff  /  :diff split", "the agent's changes, unified / side by side (s switches)"],
	[":merge [--no-squash]", "squash-merge the agent's branch into yours"],
	[":pr", "push the branch and open a pull request"],
	[":queue <prompt>", "send after the current run (:queue lists)"],
	[":pause  /  :resume", "hold the agent and its queue / continue"],
	[":dash", "all agents at a glance"],
	[":tree", "the conversation's branches; go back and branch"],
	[":w [file]", "save the transcript as Markdown"],
	[":worktrees", "list agent worktrees"],
	[":attach <branch>", "reopen an agent in a kept worktree"],
	[":worktree remove <branch>", "delete a worktree (safe; ! forces)"],
	[":colorscheme [name]", "switch theme (no name: picker)"],
	[":hi Group guifg=.. guibg=..", "change a highlight group"],
	[":hi link A B  /  :hi clear", "link groups / undo :hi"],
	[":set option / nooption", "change options (:set lists them)"],
	[":map lhs rhs", "map keys (:nmap :imap :cmap, :unmap)"],
	[":map", "list your mappings"],
	[":let mapleader = \",\"", "change the leader key"],
	[":model id", "switch the focused agent's model"],
	[":q  /  :q!", "quit (asks if agents are running) / quit anyway"],
];

/** One line of a message for previews: markdown markers and code fences dropped. */
function plainPreview(text: string): string {
	return text
		.replace(/^\s*(```|~~~)[\w+-]*\s*$/gm, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function slugifyName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "transcript"
	);
}

function describeAttr(a: Attr): string {
	const parts: string[] = [];
	if (a.fg) parts.push(`guifg=${a.fg}`);
	if (a.bg) parts.push(`guibg=${a.bg}`);
	const flags = (["bold", "italic", "underline", "reverse"] as const).filter((k) => a[k]);
	if (flags.length > 0) parts.push(`gui=${flags.join(",")}`);
	return parts.join(" ") || "cleared";
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${n} tok`;
}
