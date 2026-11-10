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
	type OverlayOptions,
	type Terminal,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "./tui.js";
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
import { dropPatch, parseDiff, restorePatch } from "./hunks.js";
import { HunkReview } from "./hunk-review.js";
import { listFiles, MENTION, mentionable } from "./attach.js";
import { allTemplates, fillTemplate, needsTask, type Template } from "./templates.js";
import type { PiUiHost } from "./pi-ui.js";
import { type AllowChoice, type CliSession, type Denial, describeDenial } from "./cli-engines.js";
import { type ServeHandle, type ServeHost, type ServeOptions, startServer } from "./serve.js";
import { HOOK_TIMEOUT_MS, type HookName, type Hooks, lastLine, runHook, took } from "./hooks.js";
import { PROJECT_CONFIG } from "./config.js";
import { didYouMean } from "./suggest.js";
import { alertSequence, NOTIFY_MODES, type NotifyMode } from "./notify.js";
import { VERSION_TEXT } from "./version.js";
import { backendName, formatBytes, riftriBackends, type RiftriHealth, RIFTRI_INSTALL } from "./riftri.js";
import { COMMAND_NAME, fillArgs, normalizeStep, type UserCommands } from "./commands.js";
import { defaultLayout, type Layout, type StatuslinePart, type WinbarPart } from "./layout.js";
import { allEngineIds, defaultEngine as defaultEngineFor, ENGINE_NAMES, type EngineId, type EngineInfo, isEngineId } from "./engines.js";
import { copyToClipboard } from "./clipboard.js";
import { splitView, unifiedView } from "./diffview.js";
import { TREE_GLYPHS, type TreeRow } from "./tree.js";
import { transcriptMarkdown } from "./export.js";
import { renderMarkdown } from "./markdown.js";
import { findHits, type Hit, nextHit, paintMatches } from "./search.js";
import { ChoicePicker, type ChoicePickerOptions, PICKER_ICONS, type PickerChoice, ThemePicker } from "./picker.js";
import { EFFORTS, effortChoicesFor, modelChoices, modelLabel } from "./choices.js";
import { ICON_SETS, NERD, toolIcon, toolKind } from "./icons.js";
import { MESSAGE_STYLES, resolveStyle, SEPARATOR_GLYPHS, SEPARATOR_STYLES, SIDEBAR_STYLES, type Style, type StyleSpec, UNICODE_TOOL_ICONS } from "./style.js";
import { mergeWorktree, openPullRequest } from "./review.js";
import type { PiSession } from "./pi-session.js";
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
	/** an agent finished (or failed) while you looked elsewhere */
	unread: string;
	/** :serve is on: a phone can follow */
	serve: string;
	/** a lightweight (copy-on-write) worktree */
	light: string;
	ok: string;
	warn: string;
	off: string;
	/** before your name and the engine's in labeled and bubble messages (a style may set them) */
	user?: string;
	agent?: string;
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
		unread: "◆",
		serve: "⇄ ",
		light: "✦",
		ok: "●",
		warn: "◐",
		off: "○",
	},
	nerd: {
		spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		state: { waiting: NERD.hourglass, idle: NERD.circleO, paused: NERD.pause, error: NERD.times },
		tee: "├╴",
		last: "└╴",
		pipe: "│ ",
		sep: "│",
		worktree: `${NERD.branch} `,
		prompt: "❯ ",
		folded: NERD.caretRight,
		open: NERD.caretDown,
		cursor: "▍",
		minus: "−",
		bullet: "•",
		queued: NERD.clock,
		open_agent: "▸",
		here: NERD.circle,
		unread: NERD.bell,
		serve: "\uf10b ",
		light: "\uf0e7",
		ok: NERD.check,
		warn: NERD.warning,
		off: NERD.circleO,
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
		unread: "!",
		serve: "~ ",
		light: "*",
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
	/** <leader>e: the cursor is in the SESSIONS sidebar (j/k pick an agent, Enter / Esc / l go back) */
	sidebarFocused = false;
	/** a key typed in the sidebar that needs a second one (gg, <leader>e) */
	private sidebarPending = "";
	altIdx = 0;

	private cmdBuf = "";
	private inputBuf = "";
	private message = "";
	private messageGroup = "Comment";
	private scrollOffset = 0; // lines from bottom
	/** the last search (n / N repeat it; its matches stay highlighted until Esc or :noh) */
	private searchQuery = "";
	/** the match the last search or n / N went to */
	private curHit?: Hit;
	/** while typing after / or ?: where the view was, to go back on Esc */
	private searchFrom?: { scroll: number; hit?: Hit; query: string; at: Hit; back: Hit };
	/** what the incremental search last showed */
	private searchPreview = "";
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
	/** yours, from [templates] in config.toml (the built-in ones are added to these) */
	templates: Record<string, Template> = {};
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
	private confirm?: { question: string; onYes: () => void; onNo?: () => void };
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

	/** [style] from config.toml: over the theme's own style */
	styleConfig: StyleSpec = {};

	/** The style in effect: the theme's, then yours (sidebar and message layout, icons). */
	get style(): Style {
		return resolveStyle(this.painter.theme.style, this.styleConfig);
	}

	private get icons(): Icons {
		const base = ICONS[this.ui.icons];
		const style = this.style;
		// [style.nerd_icons] only with a Nerd Font, over [style.icons]
		let o = this.ui.icons === "nerd" ? { ...style.icons, ...style.nerdIcons } : style.icons;
		// a Nerd Font glyph (private use area) only shows with one: without it, the icon set's own
		if (this.ui.icons !== "nerd") o = Object.fromEntries(Object.entries(o).filter(([, g]) => !/[\ue000-\uf8ff]|[\u{f0000}-\u{10ffff}]/u.test(g ?? "")));
		if (!Object.keys(o).length) return base;
		const { idle, waiting, paused, error, ...glyphs } = o;
		const state = { ...base.state };
		for (const [k, v] of Object.entries({ idle, waiting, paused, error })) if (v !== undefined) state[k as keyof typeof state] = v;
		return { ...base, ...glyphs, state };
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
		if ("extensionStatus" in s) (s as PiSession).uiHost = this.piUiHost(s);
		if (s.engine === "claude" && "asksToAllow" in s) (s as CliSession).approver = (blocked, rules) => this.askToAllow(s, blocked, rules);
		queueMicrotask(() => this.server?.sync());
		this.sessions.push(s);
		this.lastState.set(s, s.state);
		s.onChange(() => {
			this.watchState(s);
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

	/** agents that finished, failed or wait for you while you looked elsewhere */
	unread = new Set<Session>();
	/** the terminal window has focus (from focus reporting; assumed until told otherwise) */
	terminalFocused = true;
	private lastState = new WeakMap<Session, SessionState>();
	/** where notifications go (replaced in tests) */
	alert: (bytes: string) => void = (bytes) => this.terminal.write(bytes);

	/** An agent stopped running: if you're not looking at it, say so (bell, desktop notification, sidebar mark). */
	private watchState(s: Session) {
		const before = this.lastState.get(s);
		this.lastState.set(s, s.state);
		if (before === "running" && s.state !== "running") this.persist(s); // its usage totals, for after a restart
		if (before === "running" && (s.state === "idle" || s.state === "error" || s.state === "waiting")) this.agentFinishedHook(s);
		if (before !== "running" || s.state === "running" || s.state === "paused") return;
		const visible = s === this.focusedSession && this.terminalFocused;
		if (visible) return;
		this.unread.add(s);
		const n = this.sessions.indexOf(s) + 1;
		const what = s.state === "error" ? "failed" : s.state === "waiting" ? "needs you" : "finished";
		if (s !== this.focusedSession) {
			this.setMessage(`'${s.name}' ${what} · ${n <= 9 ? `${n} or ` : ""}]s to open it`, s.state === "error" ? "ErrorMsg" : "ModeMsg");
		}
		this.alert(alertSequence(`vigent: '${s.name}' ${what}`, this.ui.notify));
	}

	private focusSession(idx: number) {
		if (idx < 0 || idx >= this.sessions.length || idx === this.focusIdx) return;
		this.unread.delete(this.sessions[idx]);
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
	private ask(question: string, onYes: () => void, onNo?: () => void) {
		this.seq.reset();
		this.confirm?.onNo?.(); // a newer question replaces an unanswered one: that one is a no
		this.confirm = { question, onYes, onNo };
	}

	handleInput(data: string): void {
		// focus reporting: the terminal window gained or lost focus (never an answer to a question)
		if (data === "\x1b[I" || data === "\x1b[O") {
			this.terminalFocused = data === "\x1b[I";
			if (this.terminalFocused && this.focusedSession) this.unread.delete(this.focusedSession);
			this.tui.requestRender();
			return;
		}
		if (this.confirm) {
			const { onYes, onNo } = this.confirm;
			this.confirm = undefined;
			this.message = "";
			if (data === "y" || data === "Y") onYes();
			else onNo?.();
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
			if (this.mode === "SEARCH") this.previewSearch();
			this.tui.requestRender();
			return;
		}
		const key = keyFromInput(data);
		if (!key) return;
		if (this.sidebarFocused && this.sidebarKey(key)) {
			this.tui.requestRender();
			return;
		}
		if (this.mode === "NORMAL" && this.seq.pendingKeys.length === 0) this.message = "";
		for (const k of this.splitEscape(key)) this.seq.feed(k);
		if (this.mode === "SEARCH" && this.cmdBuf !== this.searchPreview) this.previewSearch();
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
		if (this.mode === "INSERT" && text === "@" && (this.inputBuf === "" || /\s$/.test(this.inputBuf))) {
			this.inputBuf += text;
			this.openAttach();
			return;
		}
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
				if (this.mode === "SEARCH") this.cancelSearch();
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
				this.startSearch(name === "mode.search_back");
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
			case "sidebar.focus":
				return this.toggleSidebarFocus();
			case "window.left":
			case "window.right": {
				// toward the sidebar focuses it, away from it comes back; <C-l> with nowhere to go keeps vim's meaning, redraw
				const toSidebar = (name === "window.left") === (this.ui.sidebar_position !== "right");
				if (toSidebar) {
					if (!this.sidebarFocused) this.toggleSidebarFocus();
					return;
				}
				if (this.sidebarFocused) return this.leaveSidebar();
				return name === "window.right" ? this.repaint() : undefined;
			}
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
			const query = this.cmdBuf;
			this.cmdBuf = "";
			this.mode = "NORMAL";
			this.runSearch(query);
		}
	}

	// ------------------------------------------------------------------ ex commands

	private exec(input: string) {
		const bang = /^\s*!([\s\S]*)$/.exec(input);
		if (bang) {
			if (!bang[1].trim()) this.setMessage("E471: Argument required: :!{command}", "ErrorMsg");
			else void this.runShell(bang[1].trim());
			return;
		}
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
			case "cost":
			case "usage":
				this.openUsage();
				return;
			case "pi":
			case "extensions":
				this.openPiResources();
				return;
			case "serve":
				void this.execServe(arg);
				return;
			case "trust":
				this.setMessage(this.trustProject(), "ModeMsg");
				return;
			case "tree":
				this.openTree();
				return;
			case "noh":
			case "nohl":
			case "nohlsearch":
				this.clearSearch();
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
				const templateFlag = /(?:^|\s)(?:--template|-t)[= ](\S+)/.exec(arg);
				const rest = arg
					.replace(/(?:^|\s)--model[= ]\S+/, "")
					.replace(/(?:^|\s)(?:--engine|-e)[= ]\S+/, "")
					.replace(/(?:^|\s)(?:--template|-t)[= ]\S+/, "")
					.trim();
				if (templateFlag) {
					this.startFromTemplate(templateFlag[1], rest, { worktree: cmd === "new" ? undefined : false, model: modelFlag?.[1], engine: engineFlag?.[1] });
					return;
				}
				this.startAgent(rest || `agent-${this.sessions.length + 1}`, { worktree: cmd === "new", model: modelFlag?.[1], engine: engineFlag?.[1] });
				return;
			}
			case "templates":
			case "template":
			case "tpl": {
				if (!arg) this.openTemplatePicker();
				else this.exec(`new -t ${arg}`);
				return;
			}
			case "kill":
			case "kill!":
				this.killFocused(cmd === "kill!");
				return;
			case "review":
			case "hunks":
				this.openReview();
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
			case "engine":
			case "eng":
				if (arg) this.chooseEngine(arg);
				else this.openEnginePicker();
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
				if (cmd === "command" || cmd === "command!" || cmd === "com" || cmd === "com!") return this.execCommand(arg, cmd.endsWith("!"));
				if (cmd === "delcommand" || cmd === "delc") {
					if (!this.commands[arg]) this.setMessage(`E184: No such user-defined command: ${arg}`, "ErrorMsg");
					else {
						delete this.commands[arg];
						this.setMessage(`deleted :${arg}`, "Comment");
					}
					return;
				}
				if (this.commands[cmd]) return this.runUserCommand(cmd, arg);
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
		const root = this.workspace.root;
		const merge = () => {
			const r = mergeWorktree(root, wt, { squash: !/--no-squash\b/.test(arg) });
			this.setMessage(r.ok ? `${r.message} · :kill! cleans up the worktree` : r.message, r.ok ? "ModeMsg" : "ErrorMsg");
			s.refreshStat(0);
			this.tui.requestRender();
		};
		// no before_merge hook: merge right away, as always
		if (!this.hooks.before_merge) return merge();
		void this.beforeLanding(s, "merge").then((go) => go && merge());
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
		const root = this.workspace.root;
		const push = () => {
			this.setMessage(`pushing ${wt.branch}…`, "Comment");
			this.tui.requestRender();
			const r = openPullRequest(root, wt);
			this.setMessage(r.message, r.ok ? "ModeMsg" : "ErrorMsg");
			this.tui.requestRender();
		};
		if (!this.hooks.before_merge) return push();
		void this.beforeLanding(s, "pr").then((go) => go && push());
	}

	// ---------------------------------------------------------------- hooks

	/** [hooks] from config.toml and a trusted .vigent.toml */
	hooks: Hooks = {};
	/** [statusline] and [winbar]: what they show */
	layout: Layout = defaultLayout();
	/** :trust (set by the CLI; it knows where the project's config is) */
	trustProject: () => string = () => `no ${PROJECT_CONFIG} in this project`;
	/** runs a hook (replaced in tests) */
	hookRunner: typeof runHook = runHook;
	/** [commands] and :command: your own ex commands */
	commands: UserCommands = {};
	private commandDepth = 0;

	private hookEnv(s: Session, hook: HookName, extra: Record<string, string> = {}): Record<string, string> {
		return {
			VIGENT_HOOK: hook,
			VIGENT_AGENT: s.name,
			VIGENT_ENGINE: s.engine,
			VIGENT_BRANCH: s.worktree?.branch ?? "",
			VIGENT_WORKTREE: s.worktree?.path ?? "",
			VIGENT_REPO: this.workspace.root ?? "",
			...extra,
		};
	}

	/** worktree_created: set the new worktree up (npm ci, ...) before the agent's first prompt goes out. */
	private setUpWorktree(s: Session) {
		const cmd = this.hooks.worktree_created;
		const cwd = s.worktree?.path;
		if (!cmd || !cwd) return;
		s.hold("setting up");
		s.pushInfo(`setting up the worktree: ${cmd}`);
		void this.hookRunner(cmd, { cwd, env: this.hookEnv(s, "worktree_created"), timeoutMs: HOOK_TIMEOUT_MS.worktree_created }).then((r) => {
			if (r.ok) s.pushInfo(`worktree ready (${took(r.ms)})`);
			else {
				s.pushInfo(`worktree_created ${r.timedOut ? "timed out" : `failed (exit ${r.code})`} after ${took(r.ms)}; the agent starts anyway${r.output ? `\n${r.output}` : ""}`);
				this.setMessage(`'${s.name}': worktree_created failed: ${lastLine(r.output) || `exit ${r.code}`}`, "WarningMsg");
			}
			s.release();
			this.tui.requestRender();
		});
	}

	/** before_merge: :merge and :pr go ahead only when it passes. */
	private async beforeLanding(s: Session, what: "merge" | "pr"): Promise<boolean> {
		const cmd = this.hooks.before_merge;
		const cwd = s.worktree?.path;
		if (!cmd || !cwd) return true;
		this.setMessage(`before_merge: ${cmd} in ${s.worktree?.branch}…`, "Comment");
		this.tui.requestRender();
		const r = await this.hookRunner(cmd, { cwd, env: this.hookEnv(s, "before_merge"), timeoutMs: HOOK_TIMEOUT_MS.before_merge });
		if (r.ok) return true;
		s.pushInfo(`before_merge ${r.timedOut ? "timed out" : `failed (exit ${r.code})`} after ${took(r.ms)}, so no ${what === "pr" ? "pull request" : "merge"}${r.output ? `\n${r.output}` : ""}`);
		this.setMessage(`before_merge failed, nothing ${what === "pr" ? "pushed" : "merged"}: ${lastLine(r.output) || (r.timedOut ? "timed out" : `exit ${r.code}`)}`, "ErrorMsg");
		this.tui.requestRender();
		return false;
	}

	/** agent_finished: tell your scripts an agent stopped (in the background; only a failure is shown). */
	private agentFinishedHook(s: Session) {
		const cmd = this.hooks.agent_finished;
		if (!cmd) return;
		const state = s.state === "error" ? "failed" : s.state === "waiting" ? "needs-you" : "finished";
		void this.hookRunner(cmd, {
			cwd: s.worktree?.path ?? this.workspace.root ?? process.cwd(),
			env: this.hookEnv(s, "agent_finished", { VIGENT_STATE: state }),
			timeoutMs: HOOK_TIMEOUT_MS.agent_finished,
		}).then((r) => {
			if (r.ok) return;
			this.setMessage(`agent_finished hook failed: ${lastLine(r.output) || (r.timedOut ? "timed out" : `exit ${r.code}`)}`, "WarningMsg");
			this.tui.requestRender();
		});
	}

	/** `:!cmd`: a shell command in the focused agent's worktree (else the repository). Resolves to whether it passed. */
	private async runShell(command: string, label = `:!${command}`): Promise<boolean> {
		const s = this.focusedSession;
		const cwd = s?.worktree?.path ?? this.workspace.root ?? process.cwd();
		this.setMessage(`${label} …`, "Comment");
		this.tui.requestRender();
		const env = { VIGENT_AGENT: s?.name ?? "", VIGENT_ENGINE: s?.engine ?? "", VIGENT_BRANCH: s?.worktree?.branch ?? "", VIGENT_WORKTREE: s?.worktree?.path ?? "", VIGENT_REPO: this.workspace.root ?? "" };
		const r = await this.hookRunner(command, { cwd, env, timeoutMs: 15 * 60_000 });
		const how = r.ok ? `done in ${took(r.ms)}` : r.timedOut ? `timed out after ${took(r.ms)}` : `failed (exit ${r.code}) after ${took(r.ms)}`;
		// the output goes in the agent's transcript, where you can read and search it
		s?.pushInfo(`$ ${command}  (${how})${r.output ? `\n${r.output}` : ""}`);
		const last = lastLine(r.output);
		this.setMessage(`${label}: ${how}${last ? ` · ${last}` : ""}`, r.ok ? "Comment" : "ErrorMsg");
		this.tui.requestRender();
		return r.ok;
	}

	/** Run one of your commands: each step in turn; a shell step that fails stops the rest. */
	private runUserCommand(name: string, args: string) {
		const steps = this.commands[name].map((st) => fillArgs(st, args));
		const run = async () => {
			for (const step of steps) {
				if (step.startsWith("!")) {
					if (!(await this.runShell(step.slice(1).trim(), `:${name}`))) return;
				} else {
					this.exec(step);
				}
				this.tui.requestRender();
			}
		};
		if (this.commandDepth >= 10) {
			this.setMessage(`E169: :${name} is too recursive`, "ErrorMsg");
			return;
		}
		this.commandDepth++;
		try {
			// steps before the first shell step run now, like any ex command
			void run();
		} finally {
			this.commandDepth--;
		}
	}

	/** `:command` lists yours, `:command Name` shows one, `:command[!] Name {cmd}` defines one (for this run). */
	private execCommand(arg: string, bang: boolean) {
		const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(arg);
		if (!m) {
			const names = Object.keys(this.commands).sort();
			if (!names.length) this.setMessage("no commands of your own yet: :command Name {cmd}, or [commands] in config.toml", "Comment");
			else this.setMessage(names.map((n) => `${n} = ${this.commands[n].join(" | ")}`).join("   "), "Normal");
			return;
		}
		const [, name, rhs] = m;
		if (!COMMAND_NAME.test(name)) {
			this.setMessage(`E183: User defined commands must start with an uppercase letter: ${name}`, "ErrorMsg");
			return;
		}
		if (!rhs) {
			const c = this.commands[name];
			this.setMessage(c ? `${name} = ${c.join(" | ")}` : `E184: No such user-defined command: ${name}`, c ? "Normal" : "ErrorMsg");
			return;
		}
		if (this.commands[name] && !bang) {
			this.setMessage(`E174: Command already exists: add ! to replace it: ${name}`, "ErrorMsg");
			return;
		}
		// like vim, | separates commands (a shell step keeps the rest of the line)
		const parts = rhs.split("|");
		const shell = parts.findIndex((p) => normalizeStep(p).startsWith("!"));
		const steps = [...(shell < 0 ? parts : parts.slice(0, shell)), ...(shell < 0 ? [] : [parts.slice(shell).join("|")])].map(normalizeStep).filter(Boolean);
		this.commands[name] = steps;
		this.setMessage(`:${name} = ${steps.join(" | ")}`, "Comment");
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
		// a model of another engine (codex:gpt-5.5, from the picker or typed)
		const other = /^(pi|claude|codex|opencode):(.+)$/.exec(model);
		if (other && other[1] !== t.engine) return this.chooseOtherEngine(other[1] as EngineId, other[2], t);
		if (other) model = other[2];
		const value = model === "default" ? undefined : model;
		const name = value ? modelLabel(value) : "default";
		if (!t.session) {
			if (value) this.newAgentModel[t.engine] = value;
			else delete this.newAgentModel[t.engine];
			this.setMessage(`model for new agents: ${name}`, "ModeMsg");
			return;
		}
		const s = t.session;
		Promise.resolve(s.setModel(value))
			.then(() => {
				this.persist(s);
				this.setMessage(`model for '${s.name}': ${name} (from the next prompt)`, "ModeMsg");
				this.tui.requestRender();
			})
			.catch((err) => {
				this.setMessage(String((err as Error)?.message ?? err), "ErrorMsg");
				this.tui.requestRender();
			});
	}

	/**
	 * A model from another engine's list: new agents run on that engine with it.
	 * An open agent stays where it is, since its conversation lives in its engine.
	 */
	private chooseOtherEngine(engine: EngineId, model: string, t: ReturnType<App["modelTarget"]>) {
		this.preferredEngine = engine;
		if (model === "default") delete this.newAgentModel[engine];
		else this.newAgentModel[engine] = model;
		const name = model === "default" ? "the default model" : modelLabel(model);
		const stays = t.session ? `'${t.session.name}' keeps its model (its conversation can't move) · ` : "";
		this.setMessage(`${stays}new agents use ${name} · :new <task> starts one`, "ModeMsg");
		this.repaint();
	}

	/**
	 * What :model lists: the target engine's models first, then those of every
	 * other engine that's ready, each under its name, as T3 Code does.
	 */
	private async allModelChoices(t: ReturnType<App["modelTarget"]>): Promise<PickerChoice[]> {
		const others = (["claude", "codex", "opencode", "pi"] as EngineId[]).filter((e) => e !== t.engine && this.engines?.find((x) => x.id === e)?.connected);
		const lists = await Promise.all([t.engine, ...others].map((e) => this.modelChoices(e).catch(() => [] as PickerChoice[])));
		// one plain list: names and ids, no engine headings
		return lists.flatMap((list, k) => {
			const engine = k === 0 ? t.engine : others[k - 1];
			return list
				.filter((c) => k === 0 || c.value !== "default")
				.map((c) => ({ value: k === 0 ? c.value : `${engine}:${c.value}`, label: c.label, note: c.value === "default" ? undefined : c.value }));
		});
	}

	/** `:effort <level>` */
	chooseEffort(level: string, t = this.modelTarget()) {
		const allowed = ["default", ...(EFFORTS[t.engine] ?? [])];
		// Codex's levels differ per model and version; Codex itself says if one doesn't fit
		if (!allowed.includes(level) && !(t.engine === "codex" && /^[a-z]+$/.test(level))) {
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

	/** `:engine`: which engine new agents run on, with what's ready on this machine. */
	openEnginePicker() {
		const ids: (EngineId | "auto")[] = ["auto", ...allEngineIds()];
		const items = ids.map((id) => ({ value: id, note: this.engineNote(id) }));
		this.openChoices("Engine for new agents", items, this.preferredEngine, false, (v) => this.chooseEngine(v));
	}

	/** "Claude Code · ready", "Codex · not signed in: codex login", "auto: … (now Claude Code)" */
	private engineNote(id: EngineId | "auto"): string {
		if (id === "auto") return `pick for me (now ${ENGINE_NAMES[defaultEngineFor(this.engines)]})`;
		const e = this.engines?.find((x) => x.id === id);
		if (!e) return ENGINE_NAMES[id];
		const status = e.connected ? "ready" : !e.installed ? "not installed" : e.connect ? `not signed in: ${e.connect}` : "not signed in";
		return `${ENGINE_NAMES[id]} · ${status}`;
	}

	/** `:engine <name>`: new agents run on it. Agents already open keep theirs (their conversation lives there). */
	chooseEngine(value: string) {
		if (value !== "auto" && !isEngineId(value)) {
			this.setMessage(`engines: auto, ${allEngineIds().join(", ")}`, "ErrorMsg");
			return;
		}
		this.preferredEngine = value;
		const now = this.defaultEngine();
		const e = this.engines?.find((x) => x.id === now);
		const warn = e && !e.connected ? ` (${e.installed ? `not signed in${e.connect ? `: run ${e.connect}` : ""}` : "not installed"})` : "";
		const s = this.focusedSession;
		const open = s && s.engine !== now ? ` · '${s.name}' stays on ${ENGINE_NAMES[s.engine]}; :new <task> starts one on ${ENGINE_NAMES[now]}` : "";
		this.setMessage(`new agents run on ${ENGINE_NAMES[now]}${value === "auto" ? " (auto)" : ""}${warn}${open} · :settings, w keeps it`, warn ? "WarningMsg" : "ModeMsg");
		this.repaint();
	}

	/** `:model`: pick from what the engine offers, or type any name. */
	openModelPicker(t = this.modelTarget()) {
		const current = t.session
			? "chosenModel" in t.session
				? ((t.session as { chosenModel?: string }).chosenModel ?? "default")
				: t.session.model
			: (this.newAgentModel[t.engine] ?? "default");
		this.openChoices(t.session ? `Model · '${t.session.name}'` : "Model · new agents", this.allModelChoices(t), current, true, (v) => this.chooseModel(v, t), { rows: 12 });
	}

	/** `:effort`: the reasoning effort / thinking levels the engine accepts. */
	openEffortPicker(t = this.modelTarget()) {
		const current = (t.session ? t.session.effort : this.newAgentEffort[t.engine]) ?? "default";
		this.openChoices(`Effort · ${t.label}`, this.effortChoices(t.engine, this.modelOf(t)), current, false, (v) => this.chooseEffort(v, t));
	}

	/** the model an agent (or new agents) asked for, if any */
	private modelOf(t: ReturnType<App["modelTarget"]>): string | undefined {
		if (!t.session) return this.newAgentModel[t.engine];
		return "chosenModel" in t.session ? (t.session as { chosenModel?: string }).chosenModel : t.session.model;
	}

	/** Every template: the built-in ones, then yours. */
	allTemplates(): Template[] {
		return allTemplates(this.templates);
	}

	/**
	 * `:new -t <template> [task]`: start an agent with the template's engine,
	 * model and effort, and send it the template's prompt. Flags you type
	 * (--engine, --model) win over the template's.
	 */
	startFromTemplate(name: string, task: string, opts: { worktree?: boolean; model?: string; engine?: string } = {}): Session | undefined {
		const all = this.allTemplates();
		const t = all.find((x) => x.name === name);
		if (!t) {
			this.setMessage(`no template '${name}'${didYouMean(name, all.map((x) => x.name))} · :templates lists them`, "ErrorMsg");
			return undefined;
		}
		if (needsTask(t) && !task && !(t.builtin && t.name === "review")) {
			this.setMessage(`template '${t.name}' needs a task: :new -t ${t.name} <what>`, "ErrorMsg");
			this.mode = "COMMAND";
			this.cmdBuf = `new -t ${t.name} `;
			return undefined;
		}
		const engine = opts.engine ?? t.engine;
		const s = this.startAgent(task ? agentNameFrom(task) : t.name, {
			worktree: opts.worktree ?? t.worktree,
			model: opts.model ?? (engine === t.engine || !t.engine ? t.model : undefined),
			engine,
			effort: !opts.engine || opts.engine === t.engine ? t.effort : undefined,
		});
		if (!s) return undefined;
		s.submit(fillTemplate(t, task));
		this.setMessage(`${this.message} · template ${t.name}`, this.messageGroup);
		return s;
	}

	/** `:templates`: pick one; the command line then takes the task. */
	openTemplatePicker() {
		const items = this.allTemplates().map((t) => {
			const how = [t.engine ? ENGINE_NAMES[t.engine] : "", t.model ?? "", t.effort ?? ""].filter(Boolean).join(" · ");
			const what = t.description ?? t.prompt.split("\n")[0];
			return { value: t.name, note: `${what}${how ? ` (${how})` : ""}${t.builtin ? "" : " · yours"}` };
		});
		const place = { width: Math.min(96, this.terminal.columns - 4), anchor: "center" as const };
		this.openChoices("Start an agent from a template", items, "", false, (name) => {
			const t = this.allTemplates().find((x) => x.name === name);
			if (t && !needsTask(t)) {
				this.startFromTemplate(name, "");
				return;
			}
			this.mode = "COMMAND";
			this.cmdBuf = `new -t ${name} `;
			this.setMessage(t?.builtin && t.name === "review" ? "what to focus on (optional), then Enter" : "what it's for, then Enter", "Comment");
		}, {}, place);
	}

	/** where effort levels come from (replaced in tests) */
	effortChoices: (engine: EngineId, model?: string) => Promise<PickerChoice[]> = (engine, model) => effortChoicesFor(engine, model);

	/** where model lists come from (replaced in tests) */
	modelChoices: (engine: EngineId) => Promise<PickerChoice[]> = (engine) => modelChoices(engine);

	/** where `@` finds files to attach (replaced in tests) */
	listFiles: (cwd: string) => Promise<string[]> = (cwd) => listFiles(cwd);

	/** the folder the focused agent works in: its worktree, or this checkout */
	attachDir(): string {
		const s = this.focusedSession as (Session & { cwd?: string }) | undefined;
		return s?.cwd ?? s?.worktree?.path ?? this.workspace.root ?? process.cwd();
	}

	/**
	 * `@` in the prompt: pick a file from the agent's folder. Enter writes
	 * `@path `, Esc keeps a plain `@`, Backspace takes the `@` back.
	 */
	openAttach() {
		const dir = this.attachDir();
		const items = this.listFiles(dir).then((files) => files.filter(mentionable).map((value) => ({ value })));
		const takeBack = () => {
			if (this.inputBuf.endsWith("@")) this.inputBuf = this.inputBuf.slice(0, -1);
		};
		this.openChoices(
			`Attach a file · ${path.basename(dir)}`,
			items,
			"",
			false,
			(v) => {
				takeBack();
				this.inputBuf += `@${v} `;
			},
			{ search: true, onBackOut: takeBack, rows: 8 },
			// a completion menu: just above the prompt, where you're typing
			{ anchor: "bottom-left", col: (this.ui.sidebar_position === "right" ? 0 : this.sidebarWidth(this.terminal.columns)) + 2, offsetY: -2, width: Math.min(64, this.terminal.columns - 2) },
		);
	}

	private openChoices(
		title: string,
		items: PickerChoice[] | Promise<PickerChoice[]>,
		current: string,
		custom: boolean,
		done: (v: string) => void,
		opts: ChoicePickerOptions & { onCancel?: () => void } = {},
		place: OverlayOptions = { width: Math.min(72, this.terminal.columns - 4), anchor: "center" },
	) {
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
				else opts.onCancel?.();
				this.repaint();
			},
			() => this.tui.requestRender(),
			{
				...opts,
				onBackOut: opts.onBackOut
					? () => {
							handle?.hide();
							opts.onBackOut?.();
							this.repaint();
						}
					: undefined,
			},
		);
		handle = this.tui.showOverlay(picker, place);
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
			{
				section: "Look",
				label: "Icons",
				value: () => ui.icons,
				change: () => ((ui.icons = ICON_SETS[(ICON_SETS.indexOf(ui.icons) + 1) % ICON_SETS.length]), refresh()),
				hint: "nerd: Nerd Font icons (needs a Nerd Font) · ascii: fonts without box-drawing characters",
			},
			{ section: "Look", label: "24-bit color", value: () => onOff(ui.termguicolors), change: () => ((ui.termguicolors = !ui.termguicolors), refresh()), hint: "off: the nearest of the 256 standard colors (vim's 'termguicolors')" },
			{ section: "Layout", label: "Sidebar", value: () => onOff(ui.sidebar), change: () => ((ui.sidebar = !ui.sidebar), refresh()) },
			{
				section: "Layout",
				label: "Sidebar width",
				value: () => `${ui.sidebar_width} columns`,
				change: (d) => ((ui.sidebar_width = Math.max(16, Math.min(80, ui.sidebar_width + 2 * d))), refresh()),
				hint: "h / l: 2 columns narrower / wider",
			},
			{
				section: "Layout",
				label: "Sidebar side",
				value: () => ui.sidebar_position,
				change: () => ((ui.sidebar_position = ui.sidebar_position === "left" ? "right" : "left"), refresh()),
			},
			{
				section: "Layout",
				label: "Sidebar style",
				value: () => this.style.sidebar,
				change: (d) => ((this.styleConfig = { ...this.styleConfig, sidebar: cycle([...SIDEBAR_STYLES], this.style.sidebar, d) }), refresh()),
				hint: "tree (neo-tree), cards (a box per agent), compact (a row per agent)",
			},
			{
				section: "Layout",
				label: "Messages",
				value: () => this.style.messages,
				change: (d) => ((this.styleConfig = { ...this.styleConfig, messages: cycle([...MESSAGE_STYLES], this.style.messages, d) }), refresh()),
				hint: "plain (❯ prompts), labeled (a header per message), bubbles (your prompts in boxes)",
			},
			{
				section: "Layout",
				label: "Statusline shapes",
				value: () => this.style.separators + (this.style.separators !== "none" && this.ui.icons !== "nerd" ? " (needs icons = nerd)" : ""),
				change: (d) => ((this.styleConfig = { ...this.styleConfig, separators: cycle([...SEPARATOR_STYLES], this.style.separators, d) }), refresh()),
				hint: "lualine-style segments: round, arrow or slant (Nerd Font glyphs)",
			},
			{ section: "Layout", label: "Session numbers", value: () => onOff(ui.number), change: () => ((ui.number = !ui.number), refresh()) },
			{ section: "Layout", label: "~ on empty sidebar rows", value: () => onOff(ui.tilde), change: () => ((ui.tilde = !ui.tilde), refresh()) },
			{
				section: "Agents",
				label: "Engine for new agents",
				value: () => (this.preferredEngine === "auto" ? `auto (${ENGINE_NAMES[this.defaultEngine()]})` : ENGINE_NAMES[this.preferredEngine]),
				change: (d) => {
					this.preferredEngine = cycle<EngineId | "auto">(["auto", ...allEngineIds()], this.preferredEngine, d);
				},
				hint: "auto: the first signed-in CLI, else pi with an API key · :engine picks it from anywhere",
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
					const all = ["default", ...(EFFORTS[e] ?? [])];
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
				section: "Agents",
				label: "Notify when an agent finishes",
				value: () => ({ auto: "auto (bell, and a desktop notification where the terminal shows one)", bell: "bell", desktop: "desktop notification", off: "off" })[ui.notify],
				change: (d) => (ui.notify = cycle(NOTIFY_MODES, ui.notify, d) as NotifyMode),
				hint: "when an agent finishes, fails or needs you while you're looking at another one (or another window)",
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
			for (const k of ["sidebar", "sidebar_width", "sidebar_position", "number", "tilde", "icons", "termguicolors", "transparent", "whichkey", "notify"] as const) set("ui", k, ui[k]);
			if (this.styleConfig.sidebar) set("style", "sidebar", this.styleConfig.sidebar);
			if (this.styleConfig.messages) set("style", "messages", this.styleConfig.messages);
			if (this.styleConfig.separators) set("style", "separators", this.styleConfig.separators);
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
	startAgent(name: string, opts: { worktree?: boolean; model?: string; engine?: string; effort?: string } = {}): Session | undefined {
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
		// auto lands on an engine that isn't ready only when none is; an agent started there could never answer
		if (!opts.engine && this.preferredEngine === "auto" && info && !info.connected && !info.checking) {
			this.setMessage(this.noEngineReady(), "ErrorMsg");
			return undefined;
		}
		const withWorktree = opts.worktree !== false && this.workspace.config.enabled;
		try {
			const model = opts.model ?? this.newAgentModel[engine];
			const effort = opts.effort ?? this.newAgentEffort[engine];
			const s = this.newSession(name, { worktree: withWorktree, model, engine, ...(effort ? { effort } : {}) });
			this.addSession(s);
			const wt = s.worktree;
			if (wt?.riftri) this.refreshStorage();
			if (wt?.path && this.hooks.worktree_created) this.setUpWorktree(s);
			const by = s.engine !== "pi" ? ` · ${ENGINE_NAMES[s.engine]}` : "";
			if (wt?.path) {
				const how = wt.riftri ? " · lightweight copy" : wt.riftriSkipped ? " · full copy (:checkhealth says why)" : "";
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

	/** "no engine is signed in: run claude auth login or codex login, or for pi export ANTHROPIC_API_KEY=… · :checkhealth" */
	private noEngineReady(): string {
		const engines = this.engines ?? [];
		const logins = engines.filter((e) => e.id !== "pi" && e.installed && e.connect).map((e) => e.connect);
		const pi = engines.find((e) => e.id === "pi")?.connect;
		const ways = [logins.length > 0 ? `run ${logins.join(" or ")}` : "", pi ? `for pi ${pi}` : ""].filter(Boolean).join(", or ");
		return `no engine is signed in${ways ? `: ${ways}` : ""} · :checkhealth`;
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
				["Comment", s.tokens ? `  ${formatUsage(s)}` : ""],
				["Comment", s.queue.length ? `  ${I.queued}${s.queue.length}` : ""],
				[s.state === "error" ? "ErrorMsg" : "WarningMsg", this.unread.has(s) ? `  ${I.unread} new` : ""],
			]);
			lines.push([
				["NormalFloat", "      "],
				["Comment", last ? truncateToWidth(plainPreview(last.text), 90, "…") : "(no messages yet)"],
			]);
		});
		const running = this.sessions.filter((s) => s.state === "running").length;
		lines.push([]);
		const total = totalUsage(this.sessions);
		lines.push([
			["Comment", `${this.sessions.length} agents · ${running} running · `],
			["NormalFloat", `${formatUsage(total)} in all`],
			["Comment", " · j/k move · Enter open · :cost for more"],
		]);
		this.openFloat("Dashboard", lines, Math.min(110, this.terminal.columns - 4), {
			selectable: rows,
			onSelect: (lineIdx) => this.focusSession(rows.indexOf(lineIdx)),
			initial: rows[this.focusIdx],
		});
	}

	/**
	 * Where a pi agent's extensions talk to you: confirm() is a y/n question in
	 * the command line, select() and input() are pickers, notify() goes to the
	 * transcript and the message line. Each names the agent it's from.
	 */
	piUiHost(s: Session): PiUiHost {
		const who = () => `'${s.name}'`;
		// one line, and emoji in text style (U+FE0F makes terminals disagree on their width)
		const oneLine = (t: string) => t.replace(/\uFE0F/g, "").replace(/\s+/g, " ").trim();
		const lookHere = () => {
			if (s !== this.focusedSession || !this.terminalFocused) this.alert(alertSequence(`vigent: ${who()} asks you something`, this.ui.notify));
		};
		return {
			select: (title, options) =>
				new Promise((resolve) => {
					lookHere();
					this.openChoices(`${who()} · ${oneLine(title)}`, options.map((value) => ({ value })), "", false, resolve, {
						onCancel: () => resolve(undefined),
						rows: Math.max(3, Math.min(10, options.length)),
					});
				}),
			confirm: (title, message) =>
				new Promise((resolve) => {
					lookHere();
					const text = [title, message].filter(Boolean).map(oneLine).join(": ");
					this.ask(`${who()} ${text} (y/n)`, () => resolve(true), () => resolve(false));
					this.tui.requestRender();
				}),
			input: (title, placeholder) =>
				new Promise((resolve) => {
					lookHere();
					this.openChoices(`${who()} · ${oneLine(title)}${placeholder ? ` (${oneLine(placeholder)})` : ""}`, [], "", true, resolve, { search: true, rows: 3, onCancel: () => resolve(undefined) });
				}),
			notify: (message, type) => {
				s.pushInfo(message);
				this.setMessage(`${who()}: ${message}`, type === "error" ? "ErrorMsg" : type === "warning" ? "WarningMsg" : "ModeMsg");
				this.tui.requestRender();
			},
			setStatus: (key, text) => (s as PiSession).setExtensionStatus?.(key, text),
		};
	}

	/**
	 * Claude Code refused an agent some tools ([engines.claude] ask = true):
	 * allow them for one retry, always (saved to config.toml), or leave them blocked.
	 */
	askToAllow(s: Session, blocked: Denial[], rules: string[]): Promise<AllowChoice> {
		return new Promise((resolve) => {
			if (s !== this.focusedSession || !this.terminalFocused) this.alert(alertSequence(`vigent: '${s.name}' needs a permission`, this.ui.notify));
			const what = [...new Set(blocked.map(describeDenial))].join(" · ");
			const list = rules.join(", ");
			this.openChoices(
				`'${s.name}' was blocked · ${what}`,
				[
					{ value: "allow once", note: `${list}, for this retry` },
					{ value: "always allow", note: `${list}, saved to [engines.claude] allow` },
					{ value: "no", note: "leave it blocked" },
				],
				"",
				false,
				(v) => resolve(v === "allow once" ? "once" : v === "always allow" ? "always" : undefined),
				{ onCancel: () => resolve(undefined), rows: 3 },
			);
			this.tui.requestRender();
		});
	}

	/** `:pi`: what pi loaded for the focused agent. Enter on a command, skill or prompt starts a prompt with it. */
	openPiResources() {
		const s = this.focusedSession;
		if (!s || !("resources" in s)) {
			this.setMessage(s ? `:pi lists a pi agent's extensions; '${s.name}' runs on ${ENGINE_NAMES[s.engine]}` : "no agent yet", "Comment");
			return;
		}
		const r = (s as PiSession).resources();
		if (!r) {
			this.setMessage(`'${s.name}' is still starting`, "Comment");
			return;
		}
		const lines: FloatLine[] = [];
		const rows: number[] = [];
		const typed: string[] = [];
		const home = process.env.HOME ?? "";
		const short = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : this.shortPath(p));
		const section = (title: string, n: number) => {
			if (lines.length) lines.push([]);
			lines.push([["Title", title], ["Comment", `  ${n}`]]);
		};
		const item = (name: string, note: string | undefined, insert?: string) => {
			if (insert) {
				rows.push(lines.length);
				typed.push(insert);
			}
			lines.push([
				["Identifier", `  ${name.padEnd(24)}`],
				["Comment", note ? ` ${truncateToWidth(note.replace(/\s+/g, " "), 60, "…")}` : ""],
			]);
		};
		section("Extensions", r.extensions.length);
		if (!r.extensions.length) lines.push([["Comment", "  none (~/.pi/agent/extensions/ or .pi/extensions/)"]]);
		for (const e of r.extensions) lines.push(e.error ? [["ErrorMsg", `  ${short(e.path)}`], ["Comment", `  ${e.error}`]] : [["NormalFloat", `  ${short(e.path)}`]]);
		section("Commands", r.commands.length);
		for (const c of r.commands) item(`/${c.name}`, c.description, `/${c.name} `);
		section("Skills", r.skills.length);
		for (const k of r.skills) item(`/skill:${k.name}`, k.description, `/skill:${k.name} `);
		section("Prompt templates", r.prompts.length);
		for (const p of r.prompts) item(`/${p.name}`, p.description, `/${p.name} `);
		section("Context files", r.contextFiles.length);
		for (const f of r.contextFiles) lines.push([["NormalFloat", `  ${short(f)}`]]);
		lines.push([]);
		lines.push([["Comment", "Enter starts a prompt with it · pi loads these itself, as in pi"]]);
		this.openFloat(`pi · ${s.name}`, lines, Math.min(96, this.terminal.columns - 4), {
			selectable: rows.length ? rows : undefined,
			onSelect: (lineIdx) => {
				const text = typed[rows.indexOf(lineIdx)];
				if (!text) return;
				this.mode = "INSERT";
				this.inputBuf = text;
			},
		});
	}

	/** the `:serve` server, while it runs */
	server?: ServeHandle;
	/** starts it (replaced in tests) */
	startServer: (host: ServeHost, opts: ServeOptions) => Promise<ServeHandle> = startServer;

	/** `:serve [local] [port]` starts it (or shows where it is), `:serve stop` stops it. */
	async execServe(arg: string) {
		const words = arg.split(/\s+/).filter(Boolean);
		if (words[0] === "stop") {
			if (!this.server) return this.setMessage(":serve isn't running", "Comment");
			await this.server.close();
			this.server = undefined;
			this.notify(":serve stopped", "Comment");
			return;
		}
		if (this.server) return this.openServeInfo();
		const port = Number(words.find((w) => /^\d+$/.test(w)) ?? 8377);
		const local = words.includes("local");
		try {
			this.server = await this.startServer(this.serveHost(), { port, host: local ? "127.0.0.1" : "0.0.0.0" });
		} catch (err: any) {
			const why = err?.code === "EADDRINUSE" ? `port ${port} is taken (:serve ${port + 1})` : String(err?.message ?? err);
			return this.notify(`:serve couldn't start: ${why}`, "ErrorMsg");
		}
		this.openServeInfo();
	}

	private serveHost(): ServeHost {
		return {
			sessions: () => this.sessions,
			project: () => path.basename(this.workspace.root ?? process.cwd()),
			palette: () => extractPalette(this.painter.theme),
			isUnread: (s) => this.unread.has(s),
			startAgent: (task) => this.startAgent(agentNameFrom(task)),
			notify: (text) => this.notify(text, "ModeMsg"),
		};
	}

	/** Where to open it and the access code. */
	openServeInfo() {
		const sv = this.server;
		if (!sv) return;
		const lines: FloatLine[] = [];
		lines.push([["Comment", "On your phone, open"]]);
		for (const u of sv.urls.slice(0, sv.urls.length > 1 ? -1 : undefined)) lines.push([["Title", `  ${u}`]]);
		lines.push([["Comment", "and type the access code"]]);
		lines.push([["String", `  ${sv.code}`]]);
		lines.push([]);
		lines.push([["Comment", "Or open it with the code in the link:"]]);
		lines.push([["NormalFloat", `  ${sv.urls[0]}#${sv.code}`]]);
		lines.push([]);
		if (sv.host === "127.0.0.1") lines.push([["WarningMsg", "This machine only (:serve local). :serve stop, then :serve, for your phone."]]);
		else lines.push([["Comment", "Same Wi-Fi as this machine, or a VPN like Tailscale. Plain HTTP:"], ["WarningMsg", " not on public Wi-Fi."]]);
		lines.push([["Comment", "The page lists your agents, follows a reply as it streams, and sends prompts."]]);
		lines.push([["Comment", ":serve shows this again · :serve stop ends it (and the code)"]]);
		this.openFloat("Follow from your phone", lines, Math.min(84, this.terminal.columns - 4));
	}

	/** `:cost`: what each agent has used (tokens, and money where the engine reports it) and the total. */
	openUsage() {
		if (this.sessions.length === 0) {
			this.setMessage("no agents yet (:new <task> starts one)", "Comment");
			return;
		}
		const lines: FloatLine[] = [];
		const rows: number[] = [];
		const cell = (s: string, w: number) => truncateToWidth(s, w - 1, "…").padEnd(w);
		lines.push([["Comment", `${cell("agent", 30)}${cell("engine", 13)}${"tokens".padStart(11)}${"cost".padStart(10)}`]]);
		this.sessions.forEach((s) => {
			rows.push(lines.length);
			lines.push([
				["Title", cell(s.name, 30)],
				["Comment", cell(ENGINE_NAMES[s.engine], 13)],
				["NormalFloat", formatTokens(s.tokens).replace(/ tok$/, "").padStart(11)],
				[s.cost === undefined ? "Comment" : "String", (s.cost === undefined ? "—" : formatCost(s.cost)).padStart(10)],
			]);
		});
		const total = totalUsage(this.sessions);
		lines.push([["FloatBorder", "─".repeat(64)]]);
		lines.push([
			["Title", cell("all agents", 43)],
			["NormalFloat", formatTokens(total.tokens).replace(/ tok$/, "").padStart(11)],
			["String", (total.cost === undefined ? "—" : formatCost(total.cost)).padStart(10)],
		]);
		lines.push([]);
		lines.push([["Comment", "Costs are as each engine reports them. Claude Code prices its"]]);
		lines.push([["Comment", "tokens at API rates, even on a subscription."]]);
		if (total.unpriced) lines.push([["Comment", "Codex reports no price (—); its tokens are counted."]]);
		this.openFloat("Usage", lines, Math.min(72, this.terminal.columns - 4), {
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
		if (this.sessions.length === 0) this.sidebarFocused = false;
		this.server?.sync();
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
		const width = Math.min(112, this.terminal.columns - 4);
		const lines: FloatLine[] = all.map((w) => {
			const owner = this.sessions.find((s) => s.worktree?.path === w.path);
			const backend = backends.get(w.path);
			const cols: FloatLine = [
				[owner ? "String" : "Comment", owner ? "● " : "  "],
				["Title", `${(w.branch ?? `(detached ${w.head})`).padEnd(30)} `],
				["NormalFloat", `${truncateToWidth(owner?.name ?? "", 20, "…").padEnd(20)} `],
				// the storage column only when riftri made some of them
				[backend ? "String" : "Comment", backends.size ? `${(backend ? `riftri ${backend}` : "git").padEnd(16)} ` : ""],
			];
			// a long path gives way from its start: its end names the worktree
			const room = width - 4 - visibleWidth(cols.map(([, t]) => t).join(""));
			const p = this.shortPath(w.path);
			cols.push(["Comment", visibleWidth(p) <= room || room < 8 ? p : `…${p.slice(p.length - room + 1)}`]);
			return cols;
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
	/** `:review`: keep or drop the focused agent's changes hunk by hunk. */
	private openReview() {
		const s = this.focusedSession;
		const wt = s?.worktree;
		if (!s || !wt?.path) {
			this.setMessage(s ? `'${s.name}' has no worktree to review` : "no agent", "ErrorMsg");
			return;
		}
		if (s.state === "running") {
			this.setMessage(`'${s.name}' is still working; review it when it's done (or :pause it)`, "WarningMsg");
			return;
		}
		const load = async () => parseDiff(await diffText(wt, Number.POSITIVE_INFINITY));
		load()
			.then((files) => {
				if (files.length === 0) {
					this.setMessage(`no changes on ${wt.branch} yet`, "Comment");
					this.tui.requestRender();
					return;
				}
				this.seq.reset();
				let handle: { hide(): void } | undefined;
				const after = async () => {
					s.refreshStat(0);
					return load();
				};
				const review = new HunkReview(this.painter, PICKER_ICONS[this.ui.icons], `Review ${wt.branch} vs ${wt.base ?? "base"}`, files, () => this.terminal.rows - 2, {
					drop: (patch) => dropPatch(wt.path!, patch).then(after),
					restore: (patch) => restorePatch(wt.path!, patch).then(after),
					close: () => {
						handle?.hide();
						this.repaint();
					},
					requestRender: () => this.tui.requestRender(),
				});
				handle = this.tui.showOverlay(review, { width: this.terminal.columns - 4, anchor: "center" });
				this.tui.requestRender();
			})
			.catch((err) => {
				this.setMessage(`git diff failed: ${(err as Error).message.split("\n")[0]}`, "ErrorMsg");
				this.tui.requestRender();
			});
	}

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
				const side = splitView(text, width - 3, this.ui.icons === "nerd");
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
	/** an empty row between the transcript's last line and the statusline */
	private static readonly BOTTOM_PAD = 1;

	private contentHeight(): number {
		return Math.max(1, this.terminal.rows - 3 - App.BOTTOM_PAD);
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

	/** Esc or :noh: the matches stop being highlighted (n still finds them) */
	private clearSearch() {
		this.searchQuery = "";
		this.curHit = undefined;
	}

	/**
	 * `/` or `?`: from the top of the view down, or from its bottom up, like
	 * Neovim searching from the cursor. The view comes back on Esc.
	 */
	private startSearch(backward: boolean) {
		this.mode = "SEARCH";
		this.searchBackward = backward;
		this.cmdBuf = "";
		this.searchPreview = "";
		const { start, end } = this.viewRange(this.buildPaneLines(this.paneWidth()).length);
		this.searchFrom = {
			scroll: this.scrollOffset,
			hit: this.curHit,
			query: this.searchQuery,
			at: { line: start, n: -1 },
			back: { line: Math.max(0, end - 1), n: Number.MAX_SAFE_INTEGER },
		};
	}

	/** While typing after / or ?: show the first match and highlight them all (incsearch). */
	private previewSearch() {
		const from = this.searchFrom;
		const query = this.cmdBuf;
		this.searchPreview = query;
		if (!from) return;
		this.scrollOffset = from.scroll;
		const found = query ? nextHit(findHits(query, this.buildPaneLines(this.paneWidth())), this.searchBackward ? from.back : from.at, this.searchBackward ? -1 : 1) : undefined;
		this.curHit = found?.hit;
		if (found) this.scrollToLine(found.hit.line);
	}

	/** Esc while typing a search: the view and the last search come back. */
	private cancelSearch() {
		const from = this.searchFrom;
		this.searchFrom = undefined;
		if (!from) return;
		this.scrollOffset = from.scroll;
		this.curHit = from.hit;
		this.searchQuery = from.query;
	}

	/** Enter after / or ?: go to the match and keep the search for n / N. */
	private runSearch(query: string) {
		const from = this.searchFrom;
		this.searchFrom = undefined;
		if (!query) {
			// an empty search repeats the last one, as in Vim
			if (from) this.scrollOffset = from.scroll;
			if (!this.searchQuery) return;
			this.curHit = from?.hit;
			return this.gotoMatch(1);
		}
		this.searchQuery = query;
		const hits = findHits(query, this.buildPaneLines(this.paneWidth()));
		const found = nextHit(hits, this.searchBackward ? (from?.back ?? { line: Number.MAX_SAFE_INTEGER, n: 0 }) : (from?.at ?? { line: -1, n: 0 }), this.searchBackward ? -1 : 1);
		if (!found) {
			if (from) this.scrollOffset = from.scroll;
			this.curHit = undefined;
			this.setMessage(`E486: Pattern not found: ${query}`, "ErrorMsg");
			return;
		}
		this.showHit(found, hits.length, false);
	}

	/** n (dir 1) / N (dir -1): the next match the way the last search went, or the other way. */
	private gotoMatch(dir: 1 | -1) {
		if (!this.searchQuery) {
			this.setMessage("E35: No previous regular expression", "ErrorMsg");
			return;
		}
		// the transcript may have grown since: find the matches again
		const lines = this.buildPaneLines(this.paneWidth());
		const hits = findHits(this.searchQuery, lines);
		const step = (this.searchBackward ? -dir : dir) as 1 | -1;
		const { start, end } = this.viewRange(lines.length);
		const from = this.curHit ?? (step > 0 ? { line: start, n: -1 } : { line: Math.max(0, end - 1), n: Number.MAX_SAFE_INTEGER });
		const found = nextHit(hits, from, step);
		if (!found) {
			this.setMessage(`E486: Pattern not found: ${this.searchQuery}`, "ErrorMsg");
			return;
		}
		this.showHit(found, hits.length, step !== (this.searchBackward ? -1 : 1));
	}

	/** Scroll to a match and say where it is: /term [3/7], and when the search wrapped around. */
	private showHit(found: { hit: Hit; nth: number; wrapped: boolean }, total: number, reversed: boolean) {
		this.curHit = found.hit;
		this.scrollToLine(found.hit.line);
		const up = this.searchBackward !== reversed;
		const wrap = found.wrapped ? (up ? "  search hit TOP, continuing at BOTTOM" : "  search hit BOTTOM, continuing at TOP") : "";
		this.setMessage(`${up ? "?" : "/"}${this.searchQuery}  [${found.nth}/${total}]${wrap}`, found.wrapped ? "WarningMsg" : "Search");
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
		// what's highlighted: the search being typed (incsearch), else the last one (hlsearch)
		const term = intro ? "" : this.mode === "SEARCH" ? this.cmdBuf : this.searchQuery;

		const out: string[] = [];
		// the divider on the theme's background, so it isn't a stripe of the terminal's own
		const sepBg = P.attr("Normal").bg;
		const sep = sepBg ? P.on("WinSeparator", sepBg) + this.icons.sep + RESET : P.p("WinSeparator", this.icons.sep);
		const normalBg = P.s("Normal");
		const onRight = this.ui.sidebar_position === "right";
		for (let r = 0; r < sideH; r++) {
			const left = sbW > 0 && !onRight ? sidebar[r] + sep : "";
			const right = sbW > 0 && onRight ? sep + sidebar[r] : "";
			if (r === 0) {
				out.push(left + this.renderWinbar(paneW + 2) + right);
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
			} else if (line && term) {
				// hlsearch: every match, the current one in CurSearch, the line's own colors kept
				const current = this.curHit?.line === idx ? this.curHit.n : -1;
				text = paintMatches(line.text, term, P.s("Search"), normalBg, current, P.s(this.mode === "SEARCH" ? "IncSearch" : "CurSearch"));
			}
			const pad = Math.max(0, paneW + 2 - 1 - visibleWidth(line?.plain ?? ""));
			out.push(left + bg + " " + text + bg + " ".repeat(pad) + RESET + right);
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
			case "E":
				this.openEnginePicker();
				return true;
			case "c":
				this.openHealth();
				return true;
			case "T":
				this.openTemplatePicker();
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

	/** Neovim-style 'winbar' over the transcript: which agent, its model, where it works ([winbar] picks the parts). */
	private renderWinbar(w: number): string {
		const P = this.painter;
		const bg = P.attr("WinBar").bg ?? P.attr("Normal").bg;
		const s = this.focusedSession;
		const part = (p: WinbarPart): { text: string; group: string } | undefined => {
			const text = this.winbarPart(p);
			return text ? { text, group: p === "agent" ? "WinBar" : p === "status" ? "WarningMsg" : "Comment" } : undefined;
		};
		const lefts = this.layout.winbar.left.map(part).filter((x) => x !== undefined);
		const rights = this.layout.winbar.right.map(part).filter((x) => x !== undefined);
		// with no agent there's still a name for the window
		if (!s && !lefts.some((x) => x.group === "WinBar")) lefts.unshift({ text: `${this.icons.open_agent} [no agent]`, group: "WinBar" });
		let left = "";
		let leftW = 0;
		// with powerline shapes (a Nerd Font), the agent's name sits in a rounded pill
		const seps = this.style.separators;
		const pill = seps !== "none" && this.ui.icons === "nerd" ? SEPARATOR_GLYPHS[seps] : undefined;
		const pillBg = P.attr("CursorLine").bg ?? P.attr("Visual").bg ?? bg;
		lefts.forEach((x, i) => {
			if (pill && x.group === "WinBar") {
				const [toRight, toLeft] = pill;
				const lead = i ? "  " : " ";
				left += RESET + P.on("Normal", bg) + lead + sgr({ fg: pillBg, bg }, P.colorMode) + toLeft + sgr({ fg: P.attr("Title").fg, bg: pillBg, bold: true }, P.colorMode) + ` ${x.text} ` + sgr({ fg: pillBg, bg }, P.colorMode) + toRight + RESET;
				leftW += visibleWidth(lead) + visibleWidth(toLeft) + visibleWidth(x.text) + 2 + visibleWidth(toRight);
				return;
			}
			const t = `${i ? "  " : " "}${x.text}`;
			left += (x.group === "WinBar" ? P.on("WinBar", bg) : RESET + P.on(x.group, bg)) + t;
			leftW += visibleWidth(t);
		});
		// the right side gives way first (from its start: a path's end names the worktree), always two spaces before it
		const where = rights.map((x) => x.text).join("  ");
		const room = w - leftW - 3;
		const shown = !where ? "" : visibleWidth(where) <= room ? where : room > 4 ? `…${where.slice(where.length - room + 1)}` : "";
		const right = shown ? `${shown} ` : "";
		const fill = Math.max(0, w - leftW - visibleWidth(right));
		return left + P.on("Normal", bg) + " ".repeat(fill) + P.on("Comment", bg) + right + RESET;
	}

	private winbarPart(p: WinbarPart): string {
		const s = this.focusedSession;
		switch (p) {
			case "agent":
				return `${this.icons.open_agent} ${s ? s.name : "[no agent]"}`;
			case "model":
				return s ? `${s.engine !== "pi" && s.model !== ENGINE_NAMES[s.engine] ? `${ENGINE_NAMES[s.engine]} · ` : ""}${s.model}${s.effort ? ` · ${s.effort}` : ""}` : "";
			case "engine":
				return s ? ENGINE_NAMES[s.engine] : "";
			case "effort":
				return s?.effort ?? "";
			case "status": {
				const ext = s && "extensionStatus" in s ? [...(s as PiSession).extensionStatus.values()].join(" · ") : "";
				const st = s?.state === "paused" ? (s.holdReason ?? "paused") : s?.queue.length ? `${this.icons.queued}${s.queue.length} queued` : "";
				return [st, ext].filter(Boolean).join("  ");
			}
			case "path":
				return s?.worktree?.path ? `${this.shortPath(s.worktree.path)}${s.worktree.riftri ? ` ${this.icons.light}` : ""}` : s ? "this checkout" : "";
			case "branch":
				return s?.worktree ? `${this.icons.worktree}${s.worktree.branch}` : "";
			case "usage":
				return s ? formatUsage(s) : "";
		}
	}

	/** Shown when no agent is running, like Neovim's intro screen. */
	private introLines(paneW: number, paneH: number): PaneLine[] {
		const P = this.painter;
		const center = (plain: string) => " ".repeat(Math.max(0, Math.floor((paneW - visibleWidth(plain)) / 2)));
		const rows: { text: string; plain: string }[] = [];
		const add = (text: string, plain: string, indent = center(plain)) => rows.push({ text: indent + text, plain: indent + plain });
		// LazyVim's dashboard: a big logo, then one key per action
		const logo = this.ui.icons !== "ascii" && paneW >= LOGO[0].length + 2 && paneH >= 22;
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
		const actions = DASHBOARD.map(([key, icon, label, nerd]) => [key, this.ui.icons === "nerd" ? nerd : this.ui.icons === "unicode" ? icon : "", label] as const);
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
			const foot = `${this.ui.icons === "nerd" ? `${NERD.bolt} ` : this.ui.icons === "unicode" ? "⚡ " : ""}vigent ${VERSION_TEXT} · ${listThemes().length} themes · ${ready} of ${this.engines.length} engines ready`;
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
	/** <leader>e, like neo-tree in Neovim: move the cursor into the SESSIONS sidebar, or back to the transcript. */
	toggleSidebarFocus() {
		if (this.sidebarFocused) return this.leaveSidebar();
		if (this.sessions.length === 0) {
			this.setMessage("no agents yet (i or :new starts one)", "Comment");
			return;
		}
		if (this.sidebarWidth(this.terminal.columns) === 0) {
			// no room for the sidebar (or it's turned off): the same choice as a list
			this.openDashboard();
			return;
		}
		this.mode = "NORMAL";
		this.sidebarFocused = true;
		this.sidebarPending = "";
		this.sidebarHint();
	}

	private leaveSidebar() {
		this.sidebarFocused = false;
		this.sidebarPending = "";
		this.message = "";
	}

	private sidebarHint() {
		const s = this.focusedSession;
		this.setMessage(`-- SESSIONS -- ${s ? `${this.focusIdx + 1} ${s.name} · ` : ""}j/k move · Enter open · a new · dd kill · Esc back`, "ModeMsg");
	}

	/** A key while the sidebar has the cursor. Keys it doesn't use go back to the transcript and run there. */
	private sidebarKey(key: string): boolean {
		const n = this.sessions.length;
		const pending = this.sidebarPending;
		this.sidebarPending = "";
		const go = (i: number) => {
			if (n === 0) return;
			this.focusSession(Math.max(0, Math.min(n - 1, i)));
			this.sidebarHint();
		};
		if (pending === this.keymap.leader && key === "e") {
			this.leaveSidebar();
			return true;
		}
		// neovim's window keys: toward the transcript (<C-w>l, or <C-w>h with the sidebar on the right) and <C-w>w go back
		const right = this.ui.sidebar_position === "right";
		if (pending === "<C-w>") {
			if (key === (right ? "h" : "l") || key === "w" || key === "p" || key === "<C-w>") this.leaveSidebar();
			return true;
		}
		if (key === "<C-w>") {
			this.sidebarPending = key;
			return true;
		}
		const back = right ? key === "<C-h>" || key === "<BS>" : key === "<C-l>";
		if (back) {
			this.leaveSidebar();
			return true;
		}
		if (key === "<C-h>" || key === "<BS>" || key === "<C-l>") return true;
		// act on the agent under the cursor, like neo-tree's file actions
		if (key === "d") {
			if (pending === "d") this.runAction("session.kill");
			else this.sidebarPending = "d";
			return true;
		}
		if (key === "a") {
			this.leaveSidebar();
			this.mode = "COMMAND";
			this.cmdBuf = "new ";
			return true;
		}
		switch (key) {
			case "j":
			case "<Down>":
				go(this.focusIdx + 1);
				return true;
			case "k":
			case "<Up>":
				go(this.focusIdx - 1);
				return true;
			case "G":
				go(n - 1);
				return true;
			case "g":
				if (pending === "g") go(0);
				else this.sidebarPending = "g";
				return true;
			case "<CR>":
			case "l":
			case "o":
			case "<Esc>":
			case "q":
				this.leaveSidebar();
				return true;
		}
		if (/^[1-9]$/.test(key)) {
			go(Number(key) - 1);
			return true;
		}
		if (key === this.keymap.leader) {
			this.sidebarPending = key;
			return true;
		}
		// anything else (:, i, /, ...) works as usual, back in the transcript
		this.leaveSidebar();
		if (pending === this.keymap.leader) this.seq.feed(pending);
		return false;
	}

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
		const nerd = this.ui.icons === "nerd";
		const title = this.sidebarFocused ? `${I.folded} SESSIONS` : nerd ? ` ${NERD.list} SESSIONS` : " SESSIONS";
		lines.push(
			row([
				[this.sidebarFocused ? "Title" : "WinBar", title],
				["VigentSidebar", " ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(right)))],
				["Comment", right],
			]),
		);

		const sidebarStyle = this.style.sidebar;
		const ascii = this.ui.icons === "ascii";
		this.sessions.forEach((s, i) => {
			const last = i === this.sessions.length - 1;
			const focused = i === this.focusIdx;
			// with the cursor in the sidebar, its row reads as a selection
			const rowBg = focused ? (this.sidebarFocused ? (P.attr("PmenuSel").bg ?? P.attr("Visual").bg ?? clBg) : clBg) : bg;
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
			const model = s.model.replace(/^claude-/, "");
			const marks: [string, string][] = [
				["Comment", s.queue.length > 0 ? ` ${I.queued}${s.queue.length}` : ""],
				[s.state === "error" ? "ErrorMsg" : "WarningMsg", this.unread.has(s) ? ` ${I.unread}` : ""],
			];
			const stat = s.worktree ? this.statSegments(s.worktree.stat) : [];
			const statWidth = stat.reduce((n, [, t]) => n + visibleWidth(t), 0);

			if (sidebarStyle === "compact") {
				// one row each: a bar on the focused one, state, name, and the +/- counts (quiet) at the right
				const bar = focused ? (ascii ? "> " : "▎ ") : "  ";
				const left: [string, string][] = [
					[focused ? "Title" : "LineNr", this.ui.number ? `${bar}${String(i + 1).padStart(2)} ` : bar],
					[glyphGroup, `${glyph} `],
					[focused ? "Title" : "VigentSidebar", s.name],
					...marks,
				];
				const quiet: [string, string][] = stat.map(([, t]) => ["Comment", t]);
				const leftW = left.reduce((n, [, t]) => n + visibleWidth(t), 0);
				const room = w - statWidth - 2;
				const fitted = fitSegments(left, room);
				lines.push(row([...fitted, ["VigentSidebar", " ".repeat(Math.max(1, room - Math.min(leftW, room) + 1))], ...(focused ? stat : quiet)], rowBg));
				// the focused agent opens to show where it works and what it runs on
				if (focused) {
					const pad = " ".repeat(visibleWidth(left[0][1]) + visibleWidth(`${glyph} `));
					if (s.worktree) lines.push(row([["VigentSidebar", pad], ["Comment", truncateToWidth(`${I.worktree}${s.worktree.branch}`, Math.max(4, w - pad.length - 1), "…")]]));
					lines.push(row([["VigentSidebar", pad], ["Comment", truncateToWidth(`${model} · ${formatUsage(s)}`, Math.max(4, w - pad.length - 1), "…")]]));
				}
				return;
			}

			if (sidebarStyle === "cards") {
				// a box per agent: its name, where it works, its model and what it has used
				const [tl, tr, bl, br, hz, vt] = ascii ? ["+", "+", "+", "+", "-", "|"] : ["╭", "╮", "╰", "╯", "─", "│"];
				const border = focused ? (this.sidebarFocused ? "Title" : "Special") : "VigentIndent";
				const inner = Math.max(4, w - 4);
				const label = this.ui.number ? `${hz} ${i + 1} ` : "";
				const card = (segs: [string, string][], cardBg = rowBg) => {
					const fitted = fitSegments(segs, inner);
					const used = fitted.reduce((n, [, t]) => n + visibleWidth(t), 0);
					return row([[border, `${vt} `], ...fitted, ["VigentSidebar", " ".repeat(Math.max(0, inner - used))], [border, ` ${vt}`]], cardBg);
				};
				lines.push(row([[border, `${tl}${label}${hz.repeat(Math.max(0, w - 2 - visibleWidth(label)))}${tr}`]]));
				lines.push(card([[glyphGroup, `${glyph} `], [focused ? "Title" : "VigentSidebar", s.name], ...marks]));
				if (s.worktree) {
					const branch = truncateToWidth(s.worktree.branch, Math.max(4, inner - visibleWidth(I.worktree) - statWidth), "…");
					lines.push(card([["Comment", `${I.worktree}${branch}`], ...stat]));
				}
				lines.push(card([["Comment", `${model} · ${formatUsage(s)}`]]));
				lines.push(row([[border, `${bl}${hz.repeat(Math.max(0, w - 2))}${br}`]]));
				return;
			}

			// tree: neo-tree's look
			lines.push(
				row(
					[
						[focused ? "CursorLineNr" : "LineNr", num],
						["VigentIndent", last ? I.last : I.tee],
						[glyphGroup, `${glyph} `],
						[focused ? "Title" : "VigentSidebar", s.name],
						...marks,
					],
					rowBg,
				),
			);
			const indent: [string, string][] = [
				["LineNr", " ".repeat(num.length)],
				["VigentIndent", last ? "  " : I.pipe],
			];
			if (s.worktree) {
				// the +/- counts matter more than the end of a long branch name
				// one column spare, so the counts don't run into the divider
				const room = w - num.length - 2 - 2 - visibleWidth(I.worktree) - statWidth - 1;
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
			const title = this.ui.icons === "nerd" ? ` ${NERD.chip} ENGINES` : " ENGINES";
			const count = `${ready}/${engines.length} `;
			block.push(
				row([
					["WinBar", title],
					["VigentSidebar", " ".repeat(Math.max(1, w - visibleWidth(title) - visibleWidth(count)))],
					["Comment", count],
				]),
			);
			const def = this.defaultEngine();
			// compact: the engines you have, and one line for the rest
			const folded = this.style.sidebar === "compact" ? engines.filter((e) => !e.installed && !e.checking) : [];
			for (const e of engines.filter((x) => !folded.includes(x))) {
				const glyph = e.connected ? I.ok : e.installed ? I.warn : I.off;
				const group = e.connected ? "String" : e.installed ? "WarningMsg" : "Comment";
				const note = e.checking
					? "checking…"
					: e.connected
						? e.id === def
							? "default"
							: ""
						: e.id === "pi" && e.installed
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
		if (block.length && this.style.sidebar === "compact") {
			const rest = (this.engines ?? []).filter((e) => !e.installed && !e.checking).length;
			if (rest) block.push(row([["Comment", `  ${I.off} ${rest} more · :checkhealth`]]));
		}
		while (lines.length < h - block.length) lines.push(row([["EndOfBuffer", this.ui.tilde ? "~" : ""]]));
		lines.push(...block);
		return lines.slice(0, h);
	}

	/** A tool call's glyph: Nerd Font or plain unicode, as the style (or the icon set) says. */
	private toolGlyph(name: string): string {
		const mode = this.style.toolIcons ?? (this.ui.icons === "nerd" ? "nerd" : "none");
		// Nerd Font tool icons need one; a theme asking for them gets plain unicode ones without
		if (mode === "nerd") return this.ui.icons === "nerd" || this.styleConfig.tool_icons === "nerd" ? `${toolIcon(name)} ` : `${UNICODE_TOOL_ICONS[toolKind(name)]} `;
		if (mode === "unicode") return `${UNICODE_TOOL_ICONS[toolKind(name)]} `;
		return "";
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
		const style = this.style;
		const key = `${s ? `${s.id}:${s.version}` : "empty"}:${paneW}:${this.painter.generation}:${this.ui.icons}:${JSON.stringify(style)}`;
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
					const paint = (l: string) =>
						l
							.replace(MENTION, (m) => `\0${m}\0`)
							.split("\0")
							.map((part, i) => (!part ? "" : P.p(i % 2 ? "VigentMention" : "Keyword", part)))
							.join("");
					if (style.messages === "bubbles") {
						// your prompt in a box at the right, like a chat
						const ascii = this.ui.icons === "ascii";
						const [tl, tr, bl, br, hz, vt] = ascii ? ["+", "+", "+", "+", "-", "|"] : ["╭", "╮", "╰", "╯", "─", "│"];
						const maxText = Math.max(8, Math.floor(paneW * 0.75) - 4);
						const wrapped = item.text.split("\n").flatMap((l) => wrapTextWithAnsi(l, maxText));
						const label = ` ${I.user ? `${I.user} ` : ""}${style.userLabel} `;
						const textW = Math.min(maxText, Math.max(visibleWidth(label) + 1, ...wrapped.map((l) => visibleWidth(l))));
						const pad = " ".repeat(Math.max(0, paneW - textW - 4));
						const top = `${tl}${hz}${label}${hz.repeat(Math.max(0, textW + 1 - visibleWidth(label)))}${tr}`;
						push(pad + P.p("VigentUser", top), pad + top, { item: n, start: true });
						for (const l of wrapped) {
							const fill = " ".repeat(Math.max(0, textW - visibleWidth(l)));
							push(pad + P.p("VigentUser", `${vt} `) + P.s("Normal") + paint(l) + fill + P.p("VigentUser", ` ${vt}`), `${pad}${vt} ${stripAnsi(l)}${fill} ${vt}`, { item: n });
						}
						const bottom = `${bl}${hz.repeat(textW + 2)}${br}`;
						push(pad + P.p("VigentUser", bottom), pad + bottom, { item: n });
						break;
					}
					if (style.messages === "labeled") {
						const bar = this.ui.icons === "ascii" ? "| " : "▎ ";
						const head = `${bar}${I.user ? `${I.user} ` : ""}${style.userLabel}`;
						push(P.p("VigentUser", head), head, { item: n, start: true });
						wrapTextWithAnsi(item.text, paneW - 2).forEach((l) => push(`  ${P.s("Normal")}${paint(l)}`, `  ${stripAnsi(l)}`, { item: n }));
						break;
					}
					wrapTextWithAnsi(item.text, paneW - 2).forEach((l, i) => {
						// the ❯ marks where a prompt starts; its other lines hang under it
						const lead = i === 0 ? I.prompt : " ".repeat(visibleWidth(I.prompt));
						push(P.p("VigentUser", lead) + P.s("Normal") + paint(l), lead + stripAnsi(l), {
							item: n,
							start: i === 0,
						});
					});
					break;
				}
				case "agent": {
					push("", "");
					const text = item.text + (item.streaming ? ` ${I.cursor}` : "");
					// labeled: a header naming the engine, the reply indented under it; bubbles: the name, then the reply
					const who = !s ? "agent" : this.demo ? s.model : (ENGINE_NAMES[s.engine] ?? s.engine);
					const indent = style.messages === "labeled" ? "  " : "";
					if (style.messages === "labeled") {
						const bar = this.ui.icons === "ascii" ? "| " : "▎ ";
						const head = `${bar}${I.agent ? `${I.agent} ` : ""}${who}`;
						push(P.p("Title", head), head, { item: n, start: true });
					} else if (style.messages === "bubbles") {
						const mark = I.agent ?? I.open_agent;
						push(P.p("Special", `${mark} `) + P.p("Title", who), `${mark} ${who}`, { item: n, start: true });
					}
					const md = renderMarkdown(text, paneW - indent.length, P, I.bullet, nextBlock, { ascii: this.ui.icons === "ascii" });
					md.lines.forEach((l, i) =>
						push(indent + P.s("Normal") + l.text + RESET, indent + l.plain, { item: n, start: style.messages === "plain" && i === 0, block: l.block, label: l.label }),
					);
					nextBlock += md.blocks;
					break;
				}
				case "tool": {
					const t = item.tool!;
					const fold = t.folded ? I.folded : I.open;
					const icon = this.toolGlyph(t.name);
					// under a labeled reply, tool calls line up with its text
					const ind = style.messages === "labeled" ? " " : "";
					push(
						ind + P.p("NonText", ` ${fold} `) + P.p("Special", icon) + P.p("VigentTool", t.name) + P.p("Comment", ` ${t.summary}`),
						`${ind} ${fold} ${icon}${t.name} ${t.summary}`,
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
		if (s?.thinking) {
			push("", "");
			push(P.p("Comment", "thinking…"), "thinking…");
		}
		this.paneCache = { lines, key };
		return lines;
	}

	/** mode and agent on the left, model, usage and agents on the right ([statusline] picks the parts) */
	private renderStatusline(width: number): string {
		const seps = this.style.separators;
		// powerline shapes are Nerd Font glyphs: without one, the plain statusline
		if (seps !== "none" && this.ui.icons === "nerd") return this.renderPowerline(width, SEPARATOR_GLYPHS[seps]);
		const P = this.painter;
		const s = this.focusedSession;
		const { left: leftParts, right: rightParts } = this.layout.statusline;
		let left = "";
		let leftW = 0;
		let first = true;
		for (const p of leftParts) {
			if (p === "mode") {
				const badge = ` ${this.mode} `;
				left += P.p(MODE_GROUP[this.mode], badge) + (this.demo ? P.p("VigentModeCommand", " DEMO ") : "");
				leftW += visibleWidth(badge) + (this.demo ? 6 : 0);
				continue;
			}
			const text = p === "agent" && !s ? "[no session]" : this.statuslinePart(p);
			if (!text) continue;
			// the first part stands out, the rest are quieter; a branch keeps its space after
			const t = p === "branch" ? `${text} ` : ` ${text} `;
			left += P.s(first ? "StatusLine" : "StatusLineNC") + t;
			leftW += visibleWidth(t);
			first = false;
		}
		const parts = s ? rightParts.map((p) => (p === "mode" ? ` ${this.mode} ` : this.statuslinePart(p))).filter(Boolean) : [];
		const serve = this.server ? this.icons.serve : "";
		const right = s ? (parts.length || serve ? ` ${serve}${parts.join("  ")} ` : "") : this.server ? ` ${serve}serving ` : "";
		const fill = Math.max(0, width - leftW - visibleWidth(right));
		return left + P.s(first ? "StatusLine" : "StatusLineNC") + " ".repeat(fill) + P.s("StatusLine") + right + RESET;
	}

	/**
	 * lualine's look: the mode in its color, then a lighter section, then the
	 * bar; the right side mirrors it. Each part gets its Nerd Font icon, and
	 * the shapes between sections carry one's color into the next.
	 */
	private renderPowerline(width: number, [toRight, toLeft]: [string, string]): string {
		const P = this.painter;
		const s = this.focusedSession;
		const mode = P.attr(MODE_GROUP[this.mode]);
		const fill = P.attr("StatusLine").bg ?? P.attr("Normal").bg;
		const fillFg = P.attr("Comment").fg ?? P.attr("Normal").fg;
		const middle = P.attr("CursorLine").bg ?? P.attr("Visual").bg ?? fill;
		const midFg = P.attr("Normal").fg;
		const icon: Partial<Record<StatuslinePart, string>> = {
			mode: "\ue62b", // nf-custom-vim
			agent: NERD.chip,
			model: NERD.bolt,
			engine: NERD.terminal,
			effort: NERD.gear,
			usage: "\uf201", // nf-fa-line_chart
			agents: NERD.list,
			path: "\uf07b", // nf-fa-folder
			clock: NERD.clock,
		};
		const text = (p: StatuslinePart): string => {
			if (p === "mode") return `${icon.mode} ${this.mode}${this.demo ? " · DEMO" : ""}`;
			const t = p === "agent" && !s ? "no agent" : s || p === "clock" || p === "agents" ? this.statuslinePart(p) : "";
			if (!t) return "";
			// the branch part already starts with the branch icon
			return p === "branch" || !icon[p] ? t : `${icon[p]} ${t}`;
		};
		type Seg = { text: string; fg?: string; bg?: string; bold?: boolean };
		const colors = (i: number, n: number, fromEnd: boolean): Pick<Seg, "fg" | "bg" | "bold"> => {
			const k = fromEnd ? n - 1 - i : i;
			return k === 0 ? { fg: mode.fg, bg: mode.bg, bold: true } : k === 1 ? { fg: midFg, bg: middle } : { fg: fillFg, bg: fill };
		};
		const build = (parts: StatuslinePart[], fromEnd: boolean): Seg[] => {
			const texts = parts.map(text).filter(Boolean);
			return texts.map((t, i) => ({ text: ` ${t} `, ...colors(i, texts.length, fromEnd) }));
		};
		const left = build(this.layout.statusline.left, false);
		const right = s || this.server ? build(this.layout.statusline.right, true) : [];
		const paint = (seg: Pick<Seg, "fg" | "bg" | "bold">, t: string) => sgr({ fg: seg.fg, bg: seg.bg, ...(seg.bold ? { bold: true } : {}) }, P.colorMode) + t + RESET;
		let out = "";
		let used = 0;
		const put = (seg: Pick<Seg, "fg" | "bg" | "bold">, t: string) => {
			out += paint(seg, t);
			used += visibleWidth(t);
		};
		// left: a rounded start, then each section running into the next
		if (left.length) put({ fg: left[0].bg, bg: fill }, toLeft);
		left.forEach((seg, i) => {
			put(seg, seg.text);
			put({ fg: seg.bg, bg: left[i + 1]?.bg ?? fill }, toRight);
		});
		let tail = "";
		let tailW = 0;
		right.forEach((seg, i) => {
			const prev = right[i - 1]?.bg ?? fill;
			tail += paint({ fg: seg.bg, bg: prev }, toLeft) + paint(seg, seg.text);
			tailW += visibleWidth(toLeft) + visibleWidth(seg.text);
		});
		if (right.length) {
			tail += paint({ fg: right.at(-1)!.bg, bg: fill }, toRight);
			tailW += visibleWidth(toRight);
		}
		if (used + tailW > width) {
			tail = "";
			tailW = 0;
		}
		return out + sgr({ bg: fill }, P.colorMode) + " ".repeat(Math.max(0, width - used - tailW)) + RESET + tail;
	}

	private statuslinePart(p: StatuslinePart): string {
		const s = this.focusedSession;
		switch (p) {
			case "mode":
				return this.mode;
			case "agent":
				return s ? s.name : "";
			case "branch": {
				const st = s?.worktree?.stat;
				const changes = st && (st.added || st.removed) ? ` +${st.added} ${this.icons.minus}${st.removed}` : "";
				return s?.worktree ? `${this.icons.worktree}${s.worktree.branch}${changes}` : "";
			}
			case "engine":
				return s ? ENGINE_NAMES[s.engine] : "";
			case "model":
				return s?.model ?? "";
			case "effort":
				return s?.effort ?? "";
			case "usage":
				return s ? formatUsage(s) : "";
			case "agents": {
				const running = this.sessions.filter((x) => x.state === "running").length;
				return `${running}/${this.sessions.length}${running > 0 ? ` ${this.spinner()}` : ""}`;
			}
			case "path":
				return s?.worktree?.path ? this.shortPath(s.worktree.path) : s ? "this checkout" : "";
			case "clock": {
				const d = new Date();
				return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
			}
		}
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
	[":new -t <template> <task>", "start one from a template and send it (:templates picks)"],
	[":kill  /  :kill!", "stop the agent (keep / remove its worktree)"],
	[":new! [name]", "agent in this checkout, no worktree"],
	[":diff  /  :diff split", "the agent's changes, unified / side by side (s switches)"],
	[":review", "keep or drop the agent's changes hunk by hunk"],
	[":merge [--no-squash]", "squash-merge the agent's branch into yours"],
	[":pr", "push the branch and open a pull request"],
	[":queue <prompt>", "send after the current run (:queue lists)"],
	[":pause  /  :resume", "hold the agent and its queue / continue"],
	[":dash", "all agents at a glance"],
	[":cost", "tokens and money each agent has used, and the total"],
	[":pi", "a pi agent's extensions, commands, skills and prompt templates"],
	[":serve  /  :serve stop", "follow and prompt your agents from your phone (local: this machine only)"],
	[":trust", "let this project's .vigent.toml run its hooks and engine arguments"],
	[":tree", "the conversation's branches; go back and branch"],
	[":new [task] --engine claude", "run the agent with Claude Code, codex, opencode or pi"],
	[":checkhealth", "which engines are installed and signed in"],
	[":model [name]", "pick the agent's model (no agent: for new agents)"],
	[":effort [level]", "pick its reasoning effort: low … max (pi: thinking level)"],
	[":engine [name]", "pick the engine new agents run on: auto, or any engine :checkhealth lists"],
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
	[":!{cmd}", "run a shell command in the agent's worktree; its output goes in the transcript"],
	[":command [Name] [cmd]", "your own commands: list them, show one, or define one (| separates steps)"],
	[":delcommand Name", "forget one of your commands"],
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

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${n} tok`;
}

/** US dollars: cents, or a tenth of a cent below one cent */
export function formatCost(usd: number): string {
	if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

/** "12.4k tok · $0.31", or just the tokens when the engine reports no price */
export function formatUsage(u: { tokens: number; cost?: number }): string {
	return u.cost === undefined ? formatTokens(u.tokens) : `${formatTokens(u.tokens)} · ${formatCost(u.cost)}`;
}

/** every agent's usage added up; cost counts the agents that report one */
export function totalUsage(sessions: { tokens: number; cost?: number }[]): { tokens: number; cost?: number; unpriced: number } {
	let tokens = 0;
	let cost: number | undefined;
	let unpriced = 0;
	for (const s of sessions) {
		tokens += s.tokens;
		if (s.cost === undefined) {
			if (s.tokens) unpriced++;
		} else cost = (cost ?? 0) + s.cost;
	}
	return { tokens, cost, unpriced };
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
/** key, unicode icon, label, Nerd Font icon */
const DASHBOARD: [string, string, string, string][] = [
	["i", "✎", "New agent: type a task, Enter", NERD.pencil],
	["n", "+", "New agent by name", NERD.plus],
	["T", "▤", "New agent from a template", NERD.fileText],
	["t", "◐", "Theme", NERD.palette],
	["s", "⚙", "Settings", NERD.gear],
	["m", "◆", "Model", NERD.chip],
	["e", "↯", "Effort", NERD.bolt],
	["E", "⚑", "Engine: pi, Claude Code, Codex, OpenCode", NERD.wrench],
	["c", "✓", "Check engines", NERD.check],
	["?", "⌘", "Keys", NERD.keyboard],
	["q", "×", "Quit", NERD.power],
];

/** Segments cut to fit `room` columns (the last one that doesn't fit ends in …). */
function fitSegments(segs: [string, string][], room: number): [string, string][] {
	const out: [string, string][] = [];
	let used = 0;
	for (const [g, t] of segs) {
		if (!t) continue;
		const left = room - used;
		if (left <= 0) break;
		const cut = visibleWidth(t) > left ? truncateToWidth(t, left, "…") : t;
		out.push([g, cut]);
		used += visibleWidth(cut);
	}
	return out;
}
