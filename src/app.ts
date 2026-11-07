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
import { applySetCommand, CONFIG_TEMPLATE, configPath, DEFAULT_UI, type UiOptions } from "./config.js";
import { setTomlValue, tomlValue } from "./config-edit.js";
import { type SettingItem, SettingsFloat } from "./settings.js";
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
import { VERSION_TEXT } from "./version.js";
import { backendName, formatBytes, riftriBackends, type RiftriHealth, RIFTRI_INSTALL } from "./riftri.js";
import { ENGINE_NAMES, type EngineId, type EngineInfo, isEngineId } from "./engines.js";
import { copyToClipboard } from "./clipboard.js";
import { splitView, unifiedView } from "./diffview.js";
import { TREE_GLYPHS, type TreeRow } from "./tree.js";
import { transcriptMarkdown } from "./export.js";
import { renderMarkdown } from "./markdown.js";
import { ChoicePicker, PICKER_ICONS, type PickerChoice, ThemePicker } from "./picker.js";
import { EFFORTS, effortChoices, modelChoices } from "./choices.js";
import { mergeWorktree, openPullRequest } from "./review.js";
import type { Session, SessionState } from "./session.js";
import { type Attr, BUILTIN_THEMES, extractPalette, listThemes, loadTheme, type Painter, RESET, sgr, type Theme, themeFileFor, themesDir } from "./theme.js";
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
	ok: string;
	warn: string;
	off: string;
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
		ok: "●",
		warn: "◐",
		off: "○",
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
		ok: "+",
		warn: "~",
		off: "-",
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
	newSession: (name: string, opts: { worktree: boolean; model?: string; engine?: EngineId; effort?: string }) => Session = () => {
		throw new Error("newSession factory not set");
	};

	/** pi, Claude Code, Codex, OpenCode: installed? signed in? (undefined until checked) */
	engines?: EngineInfo[];
	/** checks the engines again (:checkhealth) */
	detectEngines?: () => Promise<EngineInfo[]>;
	/** can agent worktrees be copy-on-write here (riftri)? undefined until checked */
	storage?: RiftriHealth;
	/** checks riftri again (:checkhealth) */
	checkStorage?: () => Promise<RiftriHealth>;
	/** scripted agents, no model behind them (shown in the statusline) */
	demo = false;
	/** model and effort for new agents, per engine ([engines.<id>] in config.toml, :model / :effort with no agent) */
	newAgentModel: Partial<Record<EngineId, string>> = {};
	newAgentEffort: Partial<Record<EngineId, string>> = {};
	/** save an agent's settings (model, effort) so they survive a restart */
	persist: (s: Session) => void = () => {};
	/** `engine` from config.toml or :settings; "auto" lets defaultEngine() pick */
	preferredEngine: EngineId | "auto" = "auto";
	/** key changes made in :settings, saved with w: lhs -> rhs (false unbinds) */
	private keyChanges = new Map<string, string | false>();
	/** the engine :new uses without --engine */
	defaultEngine: () => EngineId = () => "pi";

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
			hint: () => {
				if (!this.ui.whichkey) return false;
				this.tui.requestRender();
				return true;
			},
			hintDelay: () => 300,
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
		this.painter.setTransparency(this.ui.transparent ?? "auto");
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
		if (this.dashboardKey(data)) {
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
			let s = this.focusedSession;
			if (text && !s) {
				// no agent yet: the first prompt starts one, named after the task
				s = this.startAgent(agentNameFrom(text));
				if (!s) return;
			}
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
			case "checkhealth":
			case "che":
			case "engines":
				this.openHealth();
				return;
			case "settings":
			case "options":
			case "prefs":
				this.openSettings();
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
				const engineFlag = /(?:^|\s)(?:--engine|-e)[= ](\S+)/.exec(arg);
				const name =
					arg
						.replace(/(?:^|\s)--model[= ]\S+/, "")
						.replace(/(?:^|\s)(?:--engine|-e)[= ]\S+/, "")
						.trim() || `agent-${this.sessions.length + 1}`;
				this.startAgent(name, { worktree: cmd === "new", model: modelFlag?.[1], engine: engineFlag?.[1] });
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
				const save = /^save(!?)\s+(\S+)$/.exec(arg) ?? (/^save(!?)$/.test(arg) ? [arg, arg.endsWith("!") ? "!" : "", ""] : null);
				if (cmd === "theme" && save) {
					this.saveTheme(save[2], save[1] === "!");
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
				const r = applySetCommand(this.ui, arg, { transparent: this.painter.transparent });
				this.applyColorMode();
				this.setMessage(r.message, r.error ? "ErrorMsg" : "Normal");
				this.repaint();
				return;
			}
			case "model":
			case "mo":
				if (arg) this.chooseModel(arg);
				else this.openModelPicker();
				return;
			case "effort":
			case "think":
				if (arg) this.chooseEffort(arg);
				else this.openEffortPicker();
				return;
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

	/** Called when the engine checks finish. */
	setEngines(engines: EngineInfo[]) {
		this.engines = engines;
		this.tui.requestRender();
	}

	/** Who `:model` / `:effort` change: the focused agent, or new agents on the default engine. */
	private modelTarget(forNewAgents = false): { session?: Session; engine: EngineId; label: string } {
		const s = forNewAgents ? undefined : this.focusedSession;
		if (s) return { session: s, engine: s.engine, label: `'${s.name}' (${ENGINE_NAMES[s.engine]})` };
		const engine = this.defaultEngine();
		return { engine, label: `new ${ENGINE_NAMES[engine]} agents` };
	}

	/** `:model <name>` */
	chooseModel(model: string, t = this.modelTarget()) {
		const value = model === "default" ? undefined : model;
		if (!t.session) {
			if (value) this.newAgentModel[t.engine] = value;
			else delete this.newAgentModel[t.engine];
			this.setMessage(`model for ${t.label}: ${model}`, "ModeMsg");
			return;
		}
		const s = t.session;
		Promise.resolve(s.setModel(value))
			.then(() => {
				this.persist(s);
				this.setMessage(`model for ${t.label}: ${model} (from the next prompt)`, "ModeMsg");
				this.tui.requestRender();
			})
			.catch((err) => {
				this.setMessage(String((err as Error)?.message ?? err), "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/** `:effort <level>` */
	chooseEffort(level: string, t = this.modelTarget()) {
		const allowed = ["default", ...EFFORTS[t.engine]];
		if (!allowed.includes(level)) {
			this.setMessage(`${ENGINE_NAMES[t.engine]} takes: ${allowed.join(", ")}`, "ErrorMsg");
			return;
		}
		const value = level === "default" ? undefined : level;
		if (!t.session) {
			if (value) this.newAgentEffort[t.engine] = value;
			else delete this.newAgentEffort[t.engine];
			this.setMessage(`effort for ${t.label}: ${level}`, "ModeMsg");
			return;
		}
		const s = t.session;
		Promise.resolve(s.setEffort(value))
			.then(() => {
				this.persist(s);
				this.setMessage(`effort for ${t.label}: ${level} (from the next prompt)`, "ModeMsg");
				this.tui.requestRender();
			})
			.catch((err) => {
				this.setMessage(String((err as Error)?.message ?? err), "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/** `:model`: pick from what the engine offers, or type any name. */
	openModelPicker(t = this.modelTarget()) {
		const current = t.session
			? "chosenModel" in t.session
				? ((t.session as { chosenModel?: string }).chosenModel ?? "default")
				: t.session.model
			: (this.newAgentModel[t.engine] ?? "default");
		this.openChoices(`Model · ${t.label}`, this.modelChoices(t.engine), current, true, (v) => this.chooseModel(v, t));
	}

	/** `:effort`: the reasoning effort / thinking levels the engine accepts. */
	openEffortPicker(t = this.modelTarget()) {
		const current = (t.session ? t.session.effort : this.newAgentEffort[t.engine]) ?? "default";
		this.openChoices(`Effort · ${t.label}`, effortChoices(t.engine), current, false, (v) => this.chooseEffort(v, t));
	}

	/** where model lists come from (replaced in tests) */
	modelChoices: (engine: EngineId) => Promise<PickerChoice[]> = (engine) => modelChoices(engine);

	private openChoices(title: string, items: PickerChoice[] | Promise<PickerChoice[]>, current: string, custom: boolean, done: (v: string) => void) {
		this.seq.reset();
		let handle: { hide(): void } | undefined;
		const picker = new ChoicePicker(
			this.painter,
			PICKER_ICONS[this.ui.icons],
			title,
			items,
			current,
			custom,
			(v) => {
				handle?.hide();
				if (v !== null) done(v);
				this.repaint();
			},
			() => this.tui.requestRender(),
		);
		handle = this.tui.showOverlay(picker, { width: Math.min(72, this.terminal.columns - 4), anchor: "center" });
		this.tui.requestRender();
	}

	/** `:settings`: theme, look, agents and keys in one float; w saves them to config.toml. */
	openSettings() {
		this.seq.reset();
		const ui = this.ui;
		const wt = this.workspace.config;
		const onOff = (b: boolean) => (b ? "on" : "off");
		const cycle = <T,>(values: T[], now: T, dir: 1 | -1) => values[(values.indexOf(now) + dir + values.length) % values.length];
		const refresh = () => {
			this.applyColorMode();
			this.repaint();
		};
		const items: SettingItem[] = [
			{
				section: "Look",
				label: "Theme",
				value: () => this.painter.theme.name,
				open: () => {
					handle?.hide();
					this.openThemePicker();
				},
				hint: `${listThemes().length} themes, with a live preview · :theme save <name> keeps your own`,
			},
			{
				section: "Look",
				label: "Transparent background",
				value: () => (ui.transparent === "auto" ? `auto (${this.painter.transparent ? "on" : "off"}: the theme decides)` : onOff(ui.transparent)),
				change: (d) => {
					ui.transparent = cycle<boolean | "auto">(["auto", true, false], ui.transparent, d);
					refresh();
				},
				hint: "the terminal's own background shows through (its blur, opacity or wallpaper)",
			},
			{ section: "Look", label: "Icons", value: () => ui.icons, change: () => ((ui.icons = ui.icons === "unicode" ? "ascii" : "unicode"), refresh()), hint: "ascii for fonts without box-drawing characters" },
			{ section: "Look", label: "24-bit color", value: () => onOff(ui.termguicolors), change: () => ((ui.termguicolors = !ui.termguicolors), refresh()), hint: "off: the nearest of the 256 standard colors (vim's 'termguicolors')" },
			{ section: "Layout", label: "Sidebar", value: () => onOff(ui.sidebar), change: () => ((ui.sidebar = !ui.sidebar), refresh()) },
			{
				section: "Layout",
				label: "Sidebar width",
				value: () => `${ui.sidebar_width} columns`,
				change: (d) => ((ui.sidebar_width = Math.max(16, Math.min(80, ui.sidebar_width + 2 * d))), refresh()),
				hint: "h / l: 2 columns narrower / wider",
			},
			{ section: "Layout", label: "Session numbers", value: () => onOff(ui.number), change: () => ((ui.number = !ui.number), refresh()) },
			{ section: "Layout", label: "~ on empty sidebar rows", value: () => onOff(ui.tilde), change: () => ((ui.tilde = !ui.tilde), refresh()) },
			{
				section: "Agents",
				label: "Engine for new agents",
				value: () => (this.preferredEngine === "auto" ? `auto (${ENGINE_NAMES[this.defaultEngine()]})` : ENGINE_NAMES[this.preferredEngine]),
				change: (d) => {
					this.preferredEngine = cycle<EngineId | "auto">(["auto", "pi", "claude", "codex", "opencode"], this.preferredEngine, d);
				},
				hint: "auto: pi with an API key, else the first signed-in CLI · :checkhealth shows which are ready",
			},
			{
				section: "Agents",
				label: "Model for new agents",
				value: () => this.newAgentModel[this.defaultEngine()] ?? `default (${ENGINE_NAMES[this.defaultEngine()]}'s)`,
				open: () => {
					handle?.hide();
					this.openModelPicker(this.modelTarget(true));
				},
				hint: ":model in an agent changes just that agent",
			},
			{
				section: "Agents",
				label: "Effort for new agents",
				value: () => this.newAgentEffort[this.defaultEngine()] ?? "default",
				change: (d) => {
					const e = this.defaultEngine();
					const all = ["default", ...EFFORTS[e]];
					const next = cycle(all, this.newAgentEffort[e] ?? "default", d);
					if (next === "default") delete this.newAgentEffort[e];
					else this.newAgentEffort[e] = next;
				},
				hint: "reasoning effort (pi: thinking level) · :effort in an agent changes just that agent",
			},
			{ section: "Agents", label: "A worktree for each agent", value: () => onOff(wt.enabled), change: () => (wt.enabled = !wt.enabled), hint: "off: agents work in this checkout" },
			{
				section: "Agents",
				label: "Worktree storage",
				value: () => ({ auto: "auto (riftri when it can)", riftri: "riftri", git: "git" })[wt.backend ?? "auto"],
				change: (d) => (wt.backend = cycle(["auto", "riftri", "git"] as const, wt.backend ?? "auto", d) as typeof wt.backend),
				hint: "riftri: copy-on-write worktrees that share unchanged files (riftri.dev)",
			},
			{
				section: "Keys",
				label: "which-key popup",
				value: () => onOff(ui.whichkey),
				change: () => (ui.whichkey = !ui.whichkey),
				hint: "after <leader> (or any key that starts mappings), show what each next key does",
			},
			{
				section: "Keys",
				label: "Leader key",
				value: () => formatKeys(parseKeys(this.keymap.leader)),
				bind: (keys) => {
					if (keys.length !== 1) return "the leader is one key";
					this.keymap.leader = keys[0];
					return `leader is now ${keys[0]} (mappings written with <leader> use it from the next start)`;
				},
				hint: "Enter, then press the key <leader> should mean",
			},
		];
		// every NORMAL-mode mapping, one row per thing it does
		const groups = new Map<string, Binding[]>();
		for (const b of this.keymap.bindings("normal")) {
			if (b.rhs.length === 1 && b.rhs[0].kind === "nop") continue;
			// 1-9 jump to an agent: not worth a row each
			if (b.rhs.length === 1 && b.rhs[0].kind === "action" && b.rhs[0].name === "session.goto") continue;
			groups.set(b.rhsText, [...(groups.get(b.rhsText) ?? []), b]);
		}
		for (const [rhsText, bindings] of groups) {
			const label = settingsLabel(bindings[0].rhs);
			items.push({
				section: "Keys (NORMAL mode)",
				label: label.charAt(0).toUpperCase() + label.slice(1),
				value: () =>
					this.keymap
						.bindings("normal")
						.filter((b) => b.rhsText === rhsText)
						.map((b) => formatKeys(b.keys))
						.join("  ") || "(none)",
				bind: (keys) => {
					const lhs = keys.join("");
					try {
						parseKeys(lhs);
					} catch {
						return `'${lhs}' isn't a key`;
					}
					const taken = this.keymap.lookup("normal", parseKeys(lhs)).exact;
					for (const b of this.keymap.bindings("normal").filter((x) => x.rhsText === rhsText)) {
						const old = b.keys.join("");
						this.keymap.unset("normal", old);
						this.keyChanges.set(old, false);
					}
					this.keymap.set("normal", lhs, rhsText);
					this.keyChanges.set(lhs, rhsText);
					return `${formatKeys(parseKeys(lhs))} now: ${label}${taken && taken.rhsText !== rhsText ? ` (was: ${describeRhs(taken.rhs)})` : ""} · w saves it`;
				},
				hint: "Enter, then the new keys (they replace these)",
			});
		}

		let handle: { hide(): void } | undefined;
		const float = new SettingsFloat(
			this.painter,
			PICKER_ICONS[ui.icons],
			items,
			() => this.terminal.rows - 2,
			() => {
				handle?.hide();
				this.repaint();
			},
			() => this.saveSettings(),
			() => this.tui.requestRender(),
		);
		handle = this.tui.showOverlay(float, { width: Math.min(96, this.terminal.columns - 4), anchor: "center" });
		this.tui.requestRender();
	}

	/** Write what :settings changed into config.toml, keeping everything else in the file as it is. */
	saveSettings(): string {
		const file = configPath();
		try {
			let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : CONFIG_TEMPLATE;
			const ui = this.ui;
			const set = (section: string | undefined, key: string, value: string | number | boolean) => {
				text = setTomlValue(text, section, key, tomlValue(value));
			};
			set(undefined, "theme", this.painter.theme.name);
			set(undefined, "engine", this.preferredEngine);
			set(undefined, "leader", this.keymap.leader);
			for (const k of ["sidebar", "sidebar_width", "number", "tilde", "icons", "termguicolors", "transparent", "whichkey"] as const) set("ui", k, ui[k]);
			set("worktree", "enabled", this.workspace.config.enabled);
			set("worktree", "backend", this.workspace.config.backend ?? "auto");
			for (const [lhs, rhs] of this.keyChanges) set("keys.normal", lhs, rhs);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
			return `saved to ${this.shortPath(file)}`;
		} catch (err) {
			return `couldn't save: ${(err as Error).message}`;
		}
	}

	/**
	 * Start an agent (`:new`, or the first prompt typed with no agent yet).
	 * Returns it, or undefined after showing why it couldn't start.
	 */
	startAgent(name: string, opts: { worktree?: boolean; model?: string; engine?: string } = {}): Session | undefined {
		const engine = opts.engine ?? this.defaultEngine();
		if (!isEngineId(engine)) {
			this.setMessage(`unknown engine '${engine}': pi, claude, codex or opencode`, "ErrorMsg");
			return undefined;
		}
		const info = this.engines?.find((e) => e.id === engine);
		if (info && !info.installed) {
			this.setMessage(`${info.name} isn't installed: ${info.install} · :checkhealth`, "ErrorMsg");
			return undefined;
		}
		const withWorktree = opts.worktree !== false && this.workspace.config.enabled;
		try {
			const model = opts.model ?? this.newAgentModel[engine];
			const effort = this.newAgentEffort[engine];
			const s = this.newSession(name, { worktree: withWorktree, model, engine, ...(effort ? { effort } : {}) });
			this.addSession(s);
			const wt = s.worktree;
			if (wt?.riftri) this.refreshStorage();
			const by = s.engine !== "pi" ? ` · ${ENGINE_NAMES[s.engine]}` : "";
			if (wt?.path) {
				const how = wt.riftri ? ` · riftri ${wt.riftri}` : wt.riftriSkipped ? " · full copy (riftri declined: :checkhealth)" : "";
				this.setMessage(
					`'${name}'${by} on ${wt.branch} in ${this.shortPath(wt.path)}${wt.base ? ` (from ${wt.base})` : ""}${how}`,
					wt.riftriSkipped ? "WarningMsg" : "ModeMsg",
				);
			} else if (wt) {
				this.setMessage(`'${name}'${by} on ${wt.branch}`, "ModeMsg");
			} else {
				const why = !withWorktree || !this.workspace.config.enabled ? "" : " (not a git repo, so no worktree)";
				this.setMessage(`'${name}'${by} in this checkout${why}`, "ModeMsg");
			}
			return s;
		} catch (err: any) {
			this.setMessage(String(err?.message ?? err), "ErrorMsg");
			return undefined;
		}
	}

	/**
	 * `:theme save <name>`: what's on screen (the theme, your :hi changes,
	 * transparency) as ~/.config/vigent/themes/<name>.toml, then switch to it.
	 */
	private saveTheme(name: string, force: boolean) {
		if (!name || !/^[\w.-]+$/.test(name)) {
			this.setMessage("usage: :theme save <name>  (letters, digits, - _ .)", "ErrorMsg");
			return;
		}
		if (BUILTIN_THEMES[name]) {
			this.setMessage(`'${name}' is a built-in theme; save under another name`, "ErrorMsg");
			return;
		}
		const file = path.join(themesDir(), `${name}.toml`);
		if (fs.existsSync(file) && !force) {
			this.setMessage(`E13: ${this.shortPath(file)} exists (add ! to overwrite)`, "ErrorMsg");
			return;
		}
		try {
			const builtinBase = Boolean(BUILTIN_THEMES[this.painter.theme.name]) && BUILTIN_THEMES[this.painter.theme.name] === this.painter.theme;
			fs.mkdirSync(themesDir(), { recursive: true });
			fs.writeFileSync(file, themeFileFor(name, this.painter, builtinBase));
			this.setTheme(loadTheme(name));
			this.setMessage(`saved ${this.shortPath(file)} · :colorscheme ${name} (or theme = "${name}" in config.toml)`, "ModeMsg");
		} catch (err) {
			this.setMessage(`couldn't save the theme: ${(err as Error).message}`, "ErrorMsg");
		}
	}

	/** `:checkhealth` (or `:engines`): which agent engines can run, and how to connect the rest. */
	openHealth() {
		const show = () => {
			const engines = this.engines ?? [];
			const I = this.icons;
			const lines: FloatLine[] = [];
			const def = this.defaultEngine();
			lines.push([["Title", "vigent: agent engines"]]);
			lines.push([["Comment", "Each CLI runs as installed, with its own login; vigent never reads credentials."]]);
			for (const e of engines) {
				lines.push([]);
				const glyph = e.connected ? I.ok : e.installed ? I.warn : I.off;
				const group = e.connected ? "String" : e.installed ? "WarningMsg" : "Comment";
				lines.push([
					[group, `${glyph} `],
					["Title", e.name],
					["Comment", e.version ? `  ${e.version}` : ""],
					["Special", e.id === def ? "  (default for :new)" : ""],
				]);
				lines.push([["NormalFloat", "    "], [e.connected ? "NormalFloat" : group, `${e.connected ? "OK " : e.installed ? "WARNING " : ""}${e.detail}`]]);
				if (!e.installed && e.install) lines.push([["Comment", "    install: "], ["Special", e.install]]);
				else if (!e.connected && e.connect) lines.push([["Comment", "    connect: "], ["Special", e.connect]]);
				if (e.connected) lines.push([["Comment", "    use: "], ["Special", `:new <task> --engine ${e.id}`]]);
			}
			lines.push([]);
			lines.push([["Comment", "Connect in another terminal, then :checkhealth again."]]);
			lines.push(...this.storageHealthLines());
			this.openFloat("checkhealth", lines, 84);
		};
		if (!this.detectEngines && !this.checkStorage) return show();
		this.setMessage("checking engines…", "Comment");
		this.tui.requestRender();
		Promise.all([
			this.detectEngines?.() ?? Promise.resolve(this.engines),
			this.checkStorage?.().catch(() => this.storage) ?? Promise.resolve(this.storage),
		])
			.then(([engines, storage]) => {
				this.engines = engines;
				this.storage = storage;
				this.message = "";
				show();
			})
			.catch((err) => {
				this.setMessage(`checkhealth: ${(err as Error).message}`, "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/** Recount what riftri's worktrees cost, in the background. */
	private refreshStorage() {
		this.checkStorage?.()
			.then((h) => {
				this.storage = h;
				this.tui.requestRender();
			})
			.catch(() => {});
	}

	/** The worktrees part of :checkhealth: riftri, and what agent worktrees cost on disk. */
	private storageHealthLines(): FloatLine[] {
		const h = this.storage;
		if (!h) return [];
		const I = this.icons;
		const lines: FloatLine[] = [[], [["Title", "vigent: agent worktrees"]], []];
		const glyph = h.ready ? I.ok : h.installed ? I.warn : I.off;
		const group = h.ready ? "String" : h.installed ? "WarningMsg" : "Comment";
		lines.push([
			[group, `${glyph} `],
			["Title", "riftri"],
			["Comment", h.version ? `  ${h.version}` : ""],
			["Comment", "  lightweight git worktrees · riftri.dev"],
		]);
		lines.push([["NormalFloat", "    "], [h.ready ? "NormalFloat" : group, `${h.ready ? "OK " : h.installed ? "WARNING " : ""}${h.detail}`]]);
		for (const b of h.blockers) {
			wrapTextWithAnsi(b, 74).forEach((l, i) => lines.push([["NormalFloat", "    "], ["WarningMsg", i === 0 ? "- " : "  "], ["NormalFloat", l]]));
		}
		if (h.next) lines.push([["Comment", "    try: "], ["Special", h.next]]);
		if (!h.installed) lines.push([["Comment", "    install: "], ["Special", RIFTRI_INSTALL]]);
		if (h.views && h.logicalBytes !== undefined && h.allocatedBytes !== undefined) {
			const saved = Math.max(0, h.logicalBytes - h.allocatedBytes);
			lines.push([
				["NormalFloat", "    "],
				["NormalFloat", `${h.views} worktree${h.views === 1 ? "" : "s"}: ${formatBytes(h.logicalBytes)} of files in ${formatBytes(h.allocatedBytes)} on disk`],
				["String", saved > 0 ? ` (saves ${formatBytes(saved)})` : ""],
			]);
		}
		return lines;
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
		if (r.removed && wt.riftri) this.refreshStorage();
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
			if (r.removed) this.refreshStorage();
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
		const backends = riftriBackends(root, all.map((w) => w.path));
		const lines: FloatLine[] = all.map((w) => {
			const owner = this.sessions.find((s) => s.worktree?.path === w.path);
			const backend = backends.get(w.path);
			return [
				[owner ? "String" : "Comment", owner ? "● " : "  "],
				["Title", `${(w.branch ?? `(detached ${w.head})`).padEnd(30)} `],
				["NormalFloat", `${truncateToWidth(owner?.name ?? "", 20, "…").padEnd(20)} `],
				// the storage column only when riftri made some of them
				[backend ? "String" : "Comment", backends.size ? `${(backend ? `riftri ${backend}` : "git").padEnd(16)} ` : ""],
				["Comment", this.shortPath(w.path)],
			];
		});
		const st = this.storage;
		if (st?.views && st.logicalBytes !== undefined && st.allocatedBytes !== undefined) {
			lines.push([]);
			lines.push([
				["Comment", `riftri: ${formatBytes(st.logicalBytes)} of files in ${formatBytes(st.allocatedBytes)} on disk (${backendName(st.backend)})`],
			]);
		}
		lines.push([]);
		lines.push([["Comment", "● = an agent is working in it · :attach <branch> reopens one · :worktree remove <branch> deletes it"]]);
		this.openFloat("Worktrees", lines, 112);
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
			(name) => {
				try {
					const t = loadTheme(name);
					const p = extractPalette(t);
					return {
						colors: [p.bg, p.red, p.yellow, p.green, p.cyan, p.blue, p.magenta],
						tags: [t.background === "light" ? "light" : "dark", ...(t.transparent ? ["transparent"] : [])],
					};
				} catch {
					return undefined;
				}
			},
		);
		handle = this.tui.showOverlay(picker, { width: 64, anchor: "center" });
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
		if (this.seq.waiting) {
			// which-key: what can follow the keys typed so far, over the bottom of the screen
			const panel = this.whichKeyPanel(width, Math.max(3, Math.floor(sideH / 2)));
			out.splice(out.length - panel.length, panel.length, ...panel);
		}
		out.push(this.renderStatusline(width));
		out.push(this.renderCmdline(width));
		return out.map((l) => truncateToWidth(l, width));
	}

	/** The dashboard's one-key actions, while no agent is open (like LazyVim's start screen). */
	private dashboardKey(data: string): boolean {
		if (this.sessions.length > 0 || this.mode !== "NORMAL" || this.seq.pendingKeys.length > 0) return false;
		switch (keyFromInput(data)) {
			case "n":
				this.mode = "COMMAND";
				this.cmdBuf = "new ";
				return true;
			case "t":
				this.openThemePicker();
				return true;
			case "s":
				this.openSettings();
				return true;
			case "m":
				this.openModelPicker();
				return true;
			case "e":
				this.openEffortPicker();
				return true;
			case "c":
				this.openHealth();
				return true;
			case "?":
				this.openHelp();
				return true;
			case "q":
				this.exec("q");
				return true;
			default:
				return false; // i and everything else work as usual
		}
	}

	/** which-key.nvim's panel: every key that can follow the pending ones, and what it does. */
	private whichKeyPanel(width: number, maxRows: number): string[] {
		const P = this.painter;
		const I = PICKER_ICONS[this.ui.icons];
		const typed = this.seq.pendingKeys;
		const mode = this.keyMode();
		const next = new Map<string, { label: string; group: boolean }>();
		for (const b of this.keymap.bindings(mode)) {
			if (b.keys.length <= typed.length || !typed.every((k, i) => b.keys[i] === k)) continue;
			if (b.rhs.length === 1 && b.rhs[0].kind === "nop") continue;
			const key = b.keys[typed.length];
			if (b.keys.length === typed.length + 1) next.set(key, { label: whichKeyLabel(b.rhs), group: false });
			else if (!next.has(key)) next.set(key, { label: "", group: true });
		}
		for (const [key, v] of next) {
			if (!v.group) continue;
			const n = this.keymap.bindings(mode).filter((b) => b.keys.length > typed.length + 1 && b.keys[typed.length] === key && typed.every((k, i) => b.keys[i] === k)).length;
			v.label = `+${n} more`;
		}
		const items = [...next.entries()].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? 1 : -1));
		const bg = P.attr("NormalFloat").bg;
		const inner = width - 2;
		const border = (s: string) => P.on("FloatBorder", bg) + s + RESET;
		const keyW = Math.max(1, ...items.map(([k]) => visibleWidth(formatKeys([k]))));
		const colW = Math.min(46, Math.max(24, ...items.map(([k, v]) => visibleWidth(formatKeys([k])) + 3 + visibleWidth(v.label) + 3)));
		const cols = Math.max(1, Math.floor((inner - 2) / colW));
		const rowsNeeded = Math.ceil(items.length / cols);
		const rows = Math.min(rowsNeeded, Math.max(1, maxRows - 2));
		const lines: string[] = [];
		const title = ` ${formatKeys(typed)} `;
		lines.push(border(I.tl + I.h) + P.on("FloatTitle", bg) + title + RESET + border(I.h.repeat(Math.max(0, inner - 1 - visibleWidth(title))) + I.tr));
		for (let r = 0; r < rows; r++) {
			let content = P.on("NormalFloat", bg) + " ";
			let used = 1;
			for (let c = 0; c < cols; c++) {
				const item = items[c * rows + r];
				if (!item) break;
				const [k, v] = item;
				const keyText = formatKeys([k]);
				const label = truncateToWidth(v.label, colW - keyW - 4, "…");
				const cell = `${keyText.padStart(keyW)} → ${label}`;
				content +=
					P.on("Special", bg) + keyText.padStart(keyW) + P.on("Comment", bg) + " → " + P.on(v.group ? "Keyword" : "NormalFloat", bg) + label + P.on("NormalFloat", bg) + " ".repeat(Math.max(0, colW - visibleWidth(cell)));
				used += colW;
			}
			lines.push(border(I.v) + content + " ".repeat(Math.max(0, inner - used)) + RESET + border(I.v));
		}
		const more = items.length > rows * cols ? ` ${items.length - rows * cols} more: widen the terminal ` : "";
		const foot = ` Esc cancels${more ? ` ·${more}` : " "}`;
		lines.push(border(I.bl) + P.on("Comment", bg) + foot + RESET + border(I.h.repeat(Math.max(0, inner - visibleWidth(foot))) + I.br));
		return lines.map((l) => truncateToWidth(l, width));
	}

	/** Neovim-style 'winbar' over the transcript: which agent, its model, where it works. */
	private renderWinbar(w: number): string {
		const P = this.painter;
		const bg = P.attr("WinBar").bg ?? P.attr("Normal").bg;
		const s = this.focusedSession;
		const left = s ? ` ${this.icons.open_agent} ${s.name}` : ` ${this.icons.open_agent} [no agent]`;
		const model = s ? `  ${s.engine !== "pi" && s.model !== ENGINE_NAMES[s.engine] ? `${ENGINE_NAMES[s.engine]} · ` : ""}${s.model}${s.effort ? ` · ${s.effort}` : ""}` : "";
		const where = s?.worktree?.path ? `${this.shortPath(s.worktree.path)}${s.worktree.riftri ? " · riftri" : ""}` : s ? "this checkout" : "";
		const status = s?.state === "paused" ? "  paused" : s?.queue.length ? `  ${this.icons.queued}${s.queue.length} queued` : "";
		// the path gives way first (from its start: the end names the worktree), always two spaces before it
		const pathRoom = w - visibleWidth(left) - visibleWidth(model) - visibleWidth(status) - 3;
		const shownWhere = !where ? "" : visibleWidth(where) <= pathRoom ? where : pathRoom > 4 ? `…${where.slice(where.length - pathRoom + 1)}` : "";
		const right = shownWhere ? `${shownWhere} ` : "";
		const room = Math.max(0, w - visibleWidth(left) - visibleWidth(model) - visibleWidth(right));
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
		// LazyVim's dashboard: a big logo, then one key per action
		const logo = this.ui.icons === "unicode" && paneW >= LOGO[0].length + 2 && paneH >= 22;
		if (logo) {
			const groups = ["Function", "Function", "Special", "Special", "Keyword", "Keyword"];
			LOGO.forEach((l, i) => add(P.p(groups[i] ?? "Title", l), l));
		} else {
			const title = "VIGENT";
			add(P.p("Title", title), title);
		}
		const tagline = "coding agents, the vim way · each one in its own git worktree";
		add(P.p("Comment", tagline), tagline);
		add("", "");
		const actions = DASHBOARD.map(([key, icon, label]) => [key, this.ui.icons === "unicode" ? icon : "", label] as const);
		const labelW = Math.max(...actions.map(([, , l]) => l.length));
		const blockW = 2 + labelW + 6;
		const indent = center("x".repeat(blockW));
		for (const [key, icon, label] of actions) {
			const plain = `${icon ? `${icon} ` : "  "}${label.padEnd(labelW)}    ${key}`;
			add(P.p("Special", icon ? `${icon} ` : "  ") + P.p("Normal", label.padEnd(labelW)) + "    " + P.p("Title", key), plain, indent);
		}
		if (this.engines) {
			add("", "");
			const def = this.defaultEngine();
			const parts = this.engines.map((e) => `${e.connected ? this.icons.ok : e.installed ? this.icons.warn : this.icons.off} ${e.name}`);
			const plain = parts.join("   ");
			const indentE = center(plain);
			let text = "";
			this.engines.forEach((e, i) => {
				const group = e.connected ? "String" : e.installed ? "WarningMsg" : "Comment";
				text += (i ? "   " : "") + P.p(group, parts[i].slice(0, parts[i].indexOf(" ") + 1)) + P.p(e.id === def ? "Title" : "Comment", e.name);
			});
			add(text, plain, indentE);
			const ready = this.engines.filter((e) => e.connected).length;
			const foot = `${this.ui.icons === "unicode" ? "⚡ " : ""}vigent ${VERSION_TEXT} · ${listThemes().length} themes · ${ready} of ${this.engines.length} engines ready`;
			add(P.p("Comment", foot), foot);
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

		// engines at the bottom, like a second neo-tree source
		const engines = this.engines;
		const block: string[] = [];
		if (engines && h - lines.length >= engines.length + 3) {
			const ready = engines.filter((e) => e.connected).length;
			const title = " ENGINES";
			const count = `${ready}/${engines.length} `;
			block.push(
				row([
					["WinBar", title],
					["VigentSidebar", " ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(count)))],
					["Comment", count],
				]),
			);
			const def = this.defaultEngine();
			for (const e of engines) {
				const glyph = e.connected ? I.ok : e.installed ? I.warn : I.off;
				const group = e.connected ? "String" : e.installed ? "WarningMsg" : "Comment";
				const note = e.checking
					? "checking…"
					: e.connected
						? e.id === def
							? "default"
							: ""
						: e.id === "pi"
							? "no API key"
							: e.installed
								? (e.connect ?? "not signed in")
								: "not installed";
				const left = `  ${glyph} ${e.name}`;
				const room = w - visibleWidth(left) - 1;
				const tail = note ? truncateToWidth(note, Math.max(0, room - 1), "…") : "";
				block.push(
					row([
						[group, `  ${glyph} `],
						[e.connected ? "VigentSidebar" : "Comment", e.name],
						["VigentSidebar", " ".repeat(Math.max(1, room - visibleWidth(tail)))],
						["Comment", tail],
					]),
				);
			}
		}
		while (lines.length < h - block.length) lines.push(row([["EndOfBuffer", this.ui.tilde ? "~" : ""]]));
		lines.push(...block);
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
		const modeBadge = P.p(MODE_GROUP[this.mode], ` ${this.mode} `) + (this.demo ? P.p("VigentModeCommand", " DEMO ") : "");
		const running = this.sessions.filter((x) => x.state === "running").length;
		const leftText = s ? ` ${s.name} ` : " [no session] ";
		const st = s?.worktree?.stat;
		const changes = st && (st.added || st.removed) ? ` +${st.added} ${this.icons.minus}${st.removed}` : "";
		const worktree = s?.worktree ? `${this.icons.worktree}${s.worktree.branch}${changes} ` : "";
		const right = s
			? ` ${s.model}  ${formatTokens(s.tokens)}  ${running}/${this.sessions.length}${running > 0 ? ` ${this.spinner()}` : ""} `
			: "";
		const plainLen = visibleWidth(` ${this.mode} `) + (this.demo ? 6 : 0) + visibleWidth(leftText) + visibleWidth(worktree) + visibleWidth(right);
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
					P.p("PmenuSel", " ") +
					(this.sessions.length === 0 && !this.inputBuf
						? P.p("Comment", `  type what you want done; Enter starts an agent on ${ENGINE_NAMES[this.defaultEngine()]}`)
						: "");
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

/** A key's job, short, for the which-key panel: "Start an agent in its own worktree". */
function whichKeyLabel(rhs: Rhs[]): string {
	const label = settingsLabel(rhs).replace(/ \(:[^)]*\)$/, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

/** A key's job, for :settings: what an ex command does (from :help), else the action's description. */
function settingsLabel(rhs: Rhs[]): string {
	const r = rhs[0];
	if (rhs.length === 1 && r.kind === "ex") {
		const word = r.cmd.trim().split(/\s+/)[0];
		const help = EX_HELP.find(([c]) => c === `:${word}` || c.startsWith(`:${word} `));
		const cmd = `:${r.cmd.trimEnd()}${r.execute ? "" : " …"}`;
		return help ? `${help[1].split(" (")[0]} (${cmd})` : cmd;
	}
	return describeRhs(rhs);
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
	[":new [task] --engine claude", "run the agent with Claude Code, codex, opencode or pi"],
	[":checkhealth", "which engines are installed and signed in"],
	[":model [name]", "pick the agent's model (no agent: for new agents)"],
	[":effort [level]", "pick its reasoning effort: low … max (pi: thinking level)"],
	[":settings", "theme, look, engine, worktrees and keys in one place (w saves)"],
	[":w [file]", "save the transcript as Markdown"],
	[":worktrees", "list agent worktrees"],
	[":attach <branch>", "reopen an agent in a kept worktree"],
	[":worktree remove <branch>", "delete a worktree (safe; ! forces)"],
	[":colorscheme [name]", "switch theme (no name: picker)"],
	[":theme save <name>", "save the theme on screen, :hi changes included"],
	[":set transparent", "use the terminal's background (notransparent, transparent&)"],
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

/** A short agent name from a prompt: its first words, without punctuation ("Fix the flaky checkout test, please" -> "fix the flaky checkout test"). */
export function agentNameFrom(prompt: string): string {
	const words = prompt
		.toLowerCase()
		.replace(/[`'"“”‘’]/g, "")
		.replace(/[^\p{L}\p{N}/]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((w) => !["please", "pls", "can", "you", "could", "would", "the", "a", "an"].includes(w));
	const name = words.slice(0, 5).join(" ");
	return name || "agent";
}

/** The dashboard's logo (ANSI Shadow, like LazyVim's). */
const LOGO = [
	"██╗   ██╗██╗ ██████╗ ███████╗███╗   ██╗████████╗",
	"██║   ██║██║██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
	"██║   ██║██║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
	"╚██╗ ██╔╝██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
	" ╚████╔╝ ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
	"  ╚═══╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];

/** The dashboard's keys (active while no agent is open): key, icon, label. */
const DASHBOARD: [string, string, string][] = [
	["i", "✎", "New agent: type a task, Enter"],
	["n", "+", "New agent by name"],
	["t", "◐", "Theme"],
	["s", "⚙", "Settings"],
	["m", "◆", "Model"],
	["e", "↯", "Effort"],
	["c", "✓", "Check engines"],
	["?", "⌘", "Keys"],
	["q", "×", "Quit"],
];
