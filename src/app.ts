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
	parseKey,
	type Terminal,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { applySetCommand, DEFAULT_UI, type UiOptions } from "./config.js";
import { PICKER_ICONS, ThemePicker } from "./picker.js";
import type { Session, SessionState } from "./session.js";
import { type Attr, listThemes, loadTheme, type Painter, RESET, sgr, type Theme } from "./theme.js";
import { parseHighlightCommand } from "./vimcolors.js";

export type Mode = "NORMAL" | "INSERT" | "COMMAND" | "SEARCH";

const MODE_GROUP: Record<Mode, string> = {
	NORMAL: "VigentModeNormal",
	INSERT: "VigentModeInsert",
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
}

const ICONS: Record<UiOptions["icons"], Icons> = {
	unicode: {
		spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
		state: { waiting: "◐", idle: "○", error: "✗" },
		tee: "├╴",
		last: "└╴",
		pipe: "│ ",
		sep: "│",
		worktree: "⎇ ",
		prompt: "❯ ",
		folded: "▸",
		open: "▾",
		cursor: "▍",
	},
	ascii: {
		spinner: ["|", "/", "-", "\\"],
		state: { waiting: "~", idle: "o", error: "x" },
		tee: "|-",
		last: "`-",
		pipe: "| ",
		sep: "|",
		worktree: "wt:",
		prompt: "> ",
		folded: "+",
		open: "-",
		cursor: "_",
	},
};

interface PaneLine {
	text: string; // with ANSI
	plain: string; // for search
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
	private pendingKey = "";
	private scrollOffset = 0; // lines from bottom
	private searchQuery = "";
	private matches: number[] = [];
	private matchIdx = -1;
	private spinnerFrame = 0;
	private spinnerTimer?: ReturnType<typeof setInterval>;

	private paneCache: { lines: PaneLine[]; key: string } = { lines: [], key: "" };

	onQuit: () => void = () => {};
	newSession: (name: string) => Session = () => {
		throw new Error("newSession factory not set");
	};

	constructor(
		private tui: TUI,
		private terminal: Terminal,
		public painter: Painter,
		public ui: UiOptions = { ...DEFAULT_UI },
	) {}

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
		this.syncSpinner();
		this.tui.requestRender();
	}

	private focusSession(idx: number) {
		if (idx < 0 || idx >= this.sessions.length || idx === this.focusIdx) return;
		this.altIdx = this.focusIdx;
		this.focusIdx = idx;
		this.scrollOffset = 0;
		this.clearSearch();
	}

	private syncSpinner() {
		const running = this.sessions.some((s) => s.state === "running");
		if (running && !this.spinnerTimer) {
			this.spinnerTimer = setInterval(() => {
				this.spinnerFrame = (this.spinnerFrame + 1) % 120;
				this.tui.requestRender();
			}, 120);
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
	}

	invalidate(): void {
		this.paneCache.key = "";
	}

	// ------------------------------------------------------------------ input

	handleInput(data: string): void {
		const key = parseKey(data);
		switch (this.mode) {
			case "NORMAL":
				this.handleNormal(key ?? "", data);
				break;
			case "INSERT":
				this.handleTextEntry(key ?? "", data, "INSERT");
				break;
			case "COMMAND":
			case "SEARCH":
				this.handleTextEntry(key ?? "", data, this.mode);
				break;
		}
		this.tui.requestRender();
	}

	private handleNormal(key: string, data: string) {
		this.message = "";

		// two-key sequences: g_, z_, ]_, [_
		if (this.pendingKey) {
			const pending = this.pendingKey;
			this.pendingKey = "";
			if (pending === "g" && key === "g") return this.scrollTop();
			if (pending === "z") {
				const s = this.focusedSession;
				if (!s) return;
				if (key === "a") return s.toggleFolds();
				if (key === "M" || key === "shift+m") return this.setAllFolds(true);
				if (key === "R" || key === "shift+r") return this.setAllFolds(false);
				return;
			}
			if (pending === "]" && key === "s") return this.focusSession((this.focusIdx + 1) % this.sessions.length);
			if (pending === "[" && key === "s")
				return this.focusSession((this.focusIdx - 1 + this.sessions.length) % this.sessions.length);
			return;
		}

		if (key === "g" || key === "z" || key === "]" || key === "[") {
			this.pendingKey = key;
			return;
		}

		switch (key) {
			case "i":
			case "a":
			case "o":
				this.mode = "INSERT";
				return;
			case ":":
			case "shift+;":
				this.mode = "COMMAND";
				this.cmdBuf = "";
				return;
			case "/":
				this.mode = "SEARCH";
				this.cmdBuf = "";
				return;
			case "j":
			case "down":
				this.scrollBy(-1);
				return;
			case "k":
			case "up":
				this.scrollBy(1);
				return;
			case "ctrl+d":
				this.scrollBy(-Math.floor(this.contentHeight() / 2));
				return;
			case "ctrl+u":
				this.scrollBy(Math.floor(this.contentHeight() / 2));
				return;
			case "G":
			case "shift+g":
				this.scrollOffset = 0;
				return;
			case "n":
				this.gotoMatch(1);
				return;
			case "N":
			case "shift+n":
				this.gotoMatch(-1);
				return;
			case "ctrl+6":
			case "ctrl+shift+6":
			case "ctrl+^":
				this.focusSession(this.altIdx);
				return;
			case "escape":
				this.clearSearch();
				return;
			case "q":
				this.setMessage("Type  :q  and press <Enter> to exit vigent", "Comment");
				return;
		}

		// digits 1-9 jump to session N
		if (/^[1-9]$/.test(data)) {
			this.focusSession(Number(data) - 1);
			return;
		}
	}

	private handleTextEntry(key: string, data: string, mode: Mode) {
		if (key === "escape") {
			this.mode = "NORMAL";
			this.cmdBuf = "";
			return;
		}
		if (key === "enter" || key === "return") {
			if (mode === "INSERT") {
				const text = this.inputBuf.trim();
				this.inputBuf = "";
				this.mode = "NORMAL";
				if (text && this.focusedSession) {
					this.focusedSession.send(text);
					this.scrollOffset = 0;
				}
			} else if (mode === "COMMAND") {
				const cmd = this.cmdBuf;
				this.cmdBuf = "";
				this.mode = "NORMAL";
				this.exec(cmd);
			} else {
				this.searchQuery = this.cmdBuf;
				this.cmdBuf = "";
				this.mode = "NORMAL";
				this.runSearch();
			}
			return;
		}
		if (key === "backspace") {
			const buf = mode === "INSERT" ? this.inputBuf : this.cmdBuf;
			if (buf.length === 0 && mode !== "INSERT") {
				this.mode = "NORMAL"; // vim: backspace on empty cmdline exits
				return;
			}
			if (mode === "INSERT") this.inputBuf = this.inputBuf.slice(0, -1);
			else this.cmdBuf = this.cmdBuf.slice(0, -1);
			return;
		}
		if (key === "ctrl+u") {
			if (mode === "INSERT") this.inputBuf = "";
			else this.cmdBuf = "";
			return;
		}
		// printable text (filter control chars / escape sequences)
		if (data.length >= 1 && !data.startsWith("\x1b") && data >= " ") {
			if (mode === "INSERT") this.inputBuf += data;
			else this.cmdBuf += data;
		}
	}

	// ------------------------------------------------------------------ ex commands

	private exec(input: string) {
		const [cmd, ...rest] = input.trim().split(/\s+/);
		const arg = rest.join(" ");
		switch (cmd) {
			case "":
				return;
			case "q":
			case "q!":
			case "qa":
			case "qa!":
			case "quit":
				this.onQuit();
				return;
			case "new": {
				const name = arg || `agent-${this.sessions.length + 1}`;
				try {
					this.addSession(this.newSession(name));
					this.setMessage(`spawned session '${name}'`, "ModeMsg");
				} catch (err: any) {
					this.setMessage(String(err?.message ?? err), "ErrorMsg");
				}
				return;
			}
			case "kill": {
				const s = this.focusedSession;
				if (!s) return;
				s.abort();
				this.sessions.splice(this.focusIdx, 1);
				this.focusIdx = Math.max(0, Math.min(this.focusIdx, this.sessions.length - 1));
				this.setMessage(`killed session '${s.name}'`, "WarningMsg");
				return;
			}
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
				this.setMessage(
					"i prompt · j/k gg G scroll · ]s [s 1-9 sessions · za zM zR folds · /search · :new :kill :colorscheme :hi :set :q",
					"Comment",
				);
				return;
			default:
				this.setMessage(`E492: Not an editor command: ${cmd}`, "ErrorMsg");
		}
	}

	private setMessage(text: string, group: string) {
		this.message = text;
		this.messageGroup = group;
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

	private contentHeight(): number {
		return Math.max(1, this.terminal.rows - 2);
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
		this.matchIdx = (this.matchIdx + dir + this.matches.length) % this.matches.length;
		this.scrollToLine(this.matches[this.matchIdx]);
		this.announceMatch();
	}

	private announceMatch() {
		this.setMessage(`/${this.searchQuery}  match ${this.matchIdx + 1}/${this.matches.length}`, "Search");
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
		const rows = this.terminal.rows;
		const contentH = Math.max(1, rows - 2);
		const sbW = this.sidebarWidth(width);
		const paneW = this.paneWidth();

		const sidebar = sbW > 0 ? this.renderSidebar(sbW, contentH) : [];
		const paneLines = this.buildPaneLines(paneW);
		const total = paneLines.length;
		const start = Math.max(0, total - contentH - this.scrollOffset);
		const view = paneLines.slice(start, start + contentH);

		const out: string[] = [];
		const sep = P.p("WinSeparator", this.icons.sep);
		const normalBg = P.s("Normal");
		for (let r = 0; r < contentH; r++) {
			const left = sbW > 0 ? sidebar[r] + sep : "";
			const vi = r - (contentH - view.length);
			const matchLine = vi >= 0 && this.matches.includes(start + vi);
			let text = vi >= 0 ? view[vi].text : "";
			if (matchLine) text = P.s("Search") + view[vi].plain;
			const pad = Math.max(0, paneW + 2 - 1 - visibleWidth(vi >= 0 ? view[vi].plain : ""));
			out.push(left + normalBg + " " + text + normalBg + " ".repeat(pad) + RESET);
		}
		out.push(this.renderStatusline(width));
		out.push(this.renderCmdline(width));
		return out.map((l) => truncateToWidth(l, width));
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
					],
					rowBg,
				),
			);
			const model = s.model.replace(/^claude-/, "");
			const detail = s.worktree ? `${I.worktree}${s.worktree} · ${model}` : model;
			lines.push(
				row([
					["LineNr", " ".repeat(num.length)],
					["VigentIndent", last ? "  " : I.pipe],
					["Comment", `  ${detail}`],
				]),
			);
		});

		while (lines.length < h) lines.push(row([["EndOfBuffer", this.ui.tilde ? "~" : ""]]));
		return lines.slice(0, h);
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
		const push = (text: string, plain?: string) =>
			lines.push({ text: text.split(RESET).join(RESET + normal), plain: plain ?? stripAnsi(text) });

		if (!s) {
			push("");
			push(P.p("Title", "VIGENT") + P.p("Comment", " — vim-native agent orchestrator"));
			push(P.p("Comment", "type :new <name> to spawn an agent"));
		} else {
			for (const item of s.items) {
				switch (item.kind) {
					case "user": {
						push("");
						for (const l of wrapTextWithAnsi(item.text, paneW - 2)) {
							push(P.p("VigentUser", I.prompt) + P.s("Normal") + P.p("Keyword", l), I.prompt + stripAnsi(l));
						}
						break;
					}
					case "agent": {
						push("");
						const text = item.text + (item.streaming ? ` ${I.cursor}` : "");
						for (const l of wrapTextWithAnsi(text, paneW)) push(P.s("Normal") + l + RESET, stripAnsi(l));
						break;
					}
					case "tool": {
						const t = item.tool!;
						const fold = t.folded ? I.folded : I.open;
						push(
							P.p("NonText", ` ${fold} `) + P.p("VigentTool", t.name) + P.p("Comment", ` ${t.summary}`),
							` ${fold} ${t.name} ${t.summary}`,
						);
						if (!t.folded && t.output) {
							const outLines = t.output.split("\n");
							const shown = outLines.slice(0, 12);
							for (const ol of shown) {
								for (const wl of wrapTextWithAnsi(ol, paneW - 4)) {
									push("    " + P.p("VigentToolOutput", wl), "    " + stripAnsi(wl));
								}
							}
							if (outLines.length > 12) push("    " + P.p("NonText", `… ${outLines.length - 12} more lines`));
						}
						break;
					}
					case "info": {
						push("");
						for (const l of wrapTextWithAnsi(item.text, paneW)) push(P.p("Comment", l), stripAnsi(l));
						break;
					}
				}
			}
		}
		this.paneCache = { lines, key };
		return lines;
	}

	private renderStatusline(width: number): string {
		const P = this.painter;
		const s = this.focusedSession;
		const modeBadge = P.p(MODE_GROUP[this.mode], ` ${this.mode} `);
		const running = this.sessions.filter((x) => x.state === "running").length;
		const leftText = s ? ` ${s.name} ` : " [no session] ";
		const worktree = s?.worktree ? `${this.icons.worktree}${s.worktree} ` : "";
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
		switch (this.mode) {
			case "COMMAND":
				content = P.s("Normal") + ":" + this.cmdBuf + P.p("PmenuSel", " ");
				break;
			case "SEARCH":
				content = P.s("Normal") + "/" + this.cmdBuf + P.p("PmenuSel", " ");
				break;
			case "INSERT":
				content =
					P.p("ModeMsg", "-- INSERT --") + P.s("Normal") + `  ${this.icons.prompt}` + this.inputBuf + P.p("PmenuSel", " ");
				break;
			default: {
				if (this.message) content = P.p(this.messageGroup, this.message);
				else if (this.pendingKey) content = P.p("Comment", this.pendingKey);
				else content = P.p("NonText", `:help for keys`);
			}
		}
		const pad = Math.max(0, width - visibleWidth(stripAnsi(content)));
		return bg + content + bg + " ".repeat(pad) + RESET;
	}
}

function stripAnsi(s: string): string {
	// biome-ignore lint: control chars intended
	return s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
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
