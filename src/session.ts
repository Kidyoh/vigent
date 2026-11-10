/**
 * Session layer: one Session per agent.
 *
 * - PiSession (pi-session.ts) drives your installed pi in its RPC mode.
 * - DemoSession replays a scripted transcript so the UI can be explored
 *   without API keys.
 */
import type { EngineId } from "./engines.js";
import type { TreeGlyphs, TreeRow } from "./tree.js";
import { diffStat, type WorktreeInfo } from "./worktree.js";

export type SessionState = "running" | "waiting" | "idle" | "paused" | "error";

export interface ToolInfo {
	name: string;
	summary: string;
	output: string;
	folded: boolean;
}

export interface TranscriptItem {
	kind: "user" | "agent" | "tool" | "info";
	text: string;
	tool?: ToolInfo;
	streaming?: boolean;
}

export const STATE_GLYPH: Record<SessionState, string> = {
	running: "●",
	waiting: "◐",
	idle: "○",
	paused: "‖",
	error: "✗",
};

let nextId = 1;

export abstract class Session {
	id = nextId++;
	/** what runs this agent */
	engine: EngineId = "pi";
	/** reasoning effort / thinking level; undefined = the engine's default */
	effort?: string;
	state: SessionState = "idle";
	/** the model is thinking right now; only Claude Code reports this */
	thinking = false;
	items: TranscriptItem[] = [];
	tokens = 0;
	/** money spent, in US dollars, as the engine reports it; undefined = the engine doesn't say (Codex) */
	cost?: number;
	version = 0; // bumped on every change, used for render caching
	private listeners = new Set<() => void>();

	private statTimer?: ReturnType<typeof setTimeout>;
	private statRunning = false;

	constructor(
		public name: string,
		public model: string,
		public worktree?: WorktreeInfo,
	) {}

	/** Recount the worktree's changes (throttled; runs git in the background). */
	refreshStat(delayMs = 300) {
		const wt = this.worktree;
		if (!wt?.path || this.statTimer) return;
		this.statTimer = setTimeout(async () => {
			this.statTimer = undefined;
			if (this.statRunning) return this.refreshStat(delayMs);
			this.statRunning = true;
			try {
				wt.stat = await diffStat(wt);
				this.emit();
			} catch {
				// the worktree may have been removed; keep the last numbers
			} finally {
				this.statRunning = false;
			}
		}, delayMs);
	}

	/** Stop background work (stat refresh). Subclasses also stop the agent. */
	dispose() {
		if (this.statTimer) clearTimeout(this.statTimer);
		this.statTimer = undefined;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	protected emit() {
		this.version++;
		for (const cb of this.listeners) cb();
	}

	pushUser(text: string) {
		this.items.push({ kind: "user", text });
		this.emit();
	}

	pushInfo(text: string) {
		this.items.push({ kind: "info", text });
		this.emit();
	}

	/** prompts waiting for the agent to finish its current run */
	queue: string[] = [];

	setState(s: SessionState) {
		if (this.state === "paused" && s === "idle") return; // an aborted run settling while paused
		this.state = s;
		this.emit();
		if ((s === "idle" || s === "waiting") && this.queue.length > 0) {
			// next queued prompt, after the current event has been handled
			setTimeout(() => this.drainQueue(), 0);
		}
	}

	private drainQueue() {
		if (this.state === "running" || this.state === "paused" || this.queue.length === 0) return;
		const next = this.queue.shift() as string;
		this.emit();
		this.send(next);
	}

	/**
	 * Send a prompt now, or queue it if the agent is busy (or paused).
	 * Returns how many prompts are waiting after this one, or 0 if it was sent.
	 */
	submit(text: string): number {
		if (this.state === "running" || this.state === "paused") {
			this.queue.push(text);
			this.emit();
			return this.queue.length;
		}
		this.send(text);
		return 0;
	}

	/** Stop the current run and hold queued prompts until resume(). */
	pause() {
		if (this.state === "running") this.abort();
		this.state = "paused";
		this.emit();
	}

	/** why the agent is held before it can run (its worktree being set up); shown instead of "paused" */
	holdReason?: string;

	/** Hold the agent: prompts wait in its queue until release(). */
	hold(reason: string) {
		this.holdReason = reason;
		this.state = "paused";
		this.emit();
	}

	/** Let a held agent go: the prompts that waited are sent, in order. */
	release() {
		if (!this.holdReason) return;
		this.holdReason = undefined;
		this.state = "idle";
		this.emit();
		if (this.queue.length > 0) this.drainQueue();
	}

	/** Continue: the next queued prompt, or ask the agent to pick up where it stopped. */
	resume() {
		if (this.state !== "paused" || this.holdReason) return;
		this.state = "idle";
		this.emit();
		if (this.queue.length > 0) this.drainQueue();
		else this.send("Continue where you left off.");
	}

	toggleFolds(): void {
		const tools = this.items.filter((i) => i.kind === "tool" && i.tool);
		if (tools.length === 0) return;
		const anyFolded = tools.some((i) => i.tool!.folded);
		for (const i of tools) i.tool!.folded = !anyFolded;
		this.emit();
	}

	/** Use this model from the next prompt on. */
	setModel(model: string | undefined): void | Promise<void> {
		if (model) this.model = model;
		this.emit();
	}

	/** Use this reasoning effort (thinking level) from the next prompt on. */
	setEffort(effort: string | undefined): void | Promise<void> {
		this.effort = effort && effort !== "default" ? effort : undefined;
		this.emit();
	}

	/** The conversation tree (`:tree`), or undefined if this agent doesn't keep one. */
	tree(_glyphs?: TreeGlyphs): TreeRow[] | undefined {
		return undefined;
	}

	/**
	 * Go back to an earlier point. Picking a prompt rewinds to just before it and
	 * returns its text to edit and resend; picking a reply continues from there.
	 */
	async navigate(_id: string): Promise<{ editorText?: string }> {
		throw new Error("this agent doesn't keep a conversation tree");
	}

	abstract send(text: string): void;
	abstract abort(): void;
}

// ---------------------------------------------------------------------------
// Demo session — scripted streaming, no network
// ---------------------------------------------------------------------------

export interface DemoStep {
	delay: number;
	kind: "agent" | "tool" | "state" | "info";
	text?: string;
	tool?: { name: string; summary: string; output: string };
	state?: SessionState;
	/** stream the agent text at this many ms per word (0 = instant) */
	streamMs?: number;
}

export class DemoSession extends Session {
	private timer?: ReturnType<typeof setTimeout>;
	private script: DemoStep[] = [];

	play(steps: DemoStep[]) {
		this.script = [...steps];
		this.next();
	}

	private next() {
		const step = this.script.shift();
		if (!step) return;
		this.timer = setTimeout(() => this.run(step), step.delay);
	}

	private run(step: DemoStep) {
		switch (step.kind) {
			case "state":
				this.setState(step.state!);
				break;
			case "info":
				this.pushInfo(step.text ?? "");
				break;
			case "tool": {
				this.items.push({
					kind: "tool",
					text: "",
					tool: { ...step.tool!, folded: true },
				});
				this.tokens += Math.ceil((step.tool!.output.length + step.tool!.summary.length) / 4);
				this.emit();
				break;
			}
			case "agent": {
				const words = (step.text ?? "").split(" ");
				if (!step.streamMs) {
					this.items.push({ kind: "agent", text: step.text ?? "" });
					this.tokens += Math.ceil((step.text ?? "").length / 4);
					this.emit();
					break;
				}
				const item: TranscriptItem = { kind: "agent", text: "", streaming: true };
				this.items.push(item);
				let i = 0;
				const tick = () => {
					if (i >= words.length) {
						item.streaming = false;
						this.emit();
						this.next();
						return;
					}
					item.text += (i > 0 ? " " : "") + words[i++];
					this.tokens += 1;
					this.emit();
					this.timer = setTimeout(tick, step.streamMs);
				};
				tick();
				return; // next() is called when streaming finishes
			}
		}
		this.next();
	}

	send(text: string): void {
		this.pushUser(text);
		this.setState("running");
		this.play([
			{ delay: 500, kind: "agent", streamMs: 60, text: "Got it — I'll take a look and get back to you. (demo mode: no model behind this session)" },
			{ delay: 200, kind: "state", state: "idle" },
		]);
	}

	abort(): void {
		if (this.timer) clearTimeout(this.timer);
		this.script = [];
		this.setState("idle");
	}
}

/** Rebuild the transcript from pi's saved messages: prompts, replies, and tool calls with their output. */
export function itemsFromMessages(messages: any[]): { items: TranscriptItem[]; tokens: number; cost?: number } {
	const items: TranscriptItem[] = [];
	const byCallId = new Map<string, TranscriptItem>();
	let tokens = 0;
	let cost: number | undefined;
	for (const m of messages) {
		if (m?.role === "user") {
			const text = extractText(m.content);
			if (text) items.push({ kind: "user", text });
		} else if (m?.role === "assistant") {
			const blocks: any[] = Array.isArray(m.content) ? m.content : [];
			const text = extractText(blocks);
			if (text) items.push({ kind: "agent", text });
			for (const b of blocks) {
				if (b?.type !== "toolCall") continue;
				const item: TranscriptItem = {
					kind: "tool",
					text: "",
					tool: { name: b.name, summary: summarizeArgs(b.arguments), output: "", folded: true },
				};
				items.push(item);
				if (b.id) byCallId.set(b.id, item);
			}
			if (m.usage) {
				tokens += usageTokens(m.usage);
				if (typeof m.usage.cost?.total === "number") cost = (cost ?? 0) + m.usage.cost.total;
			}
			const err = piError(m);
			if (err) items.push({ kind: "info", text: err });
		} else if (m?.role === "toolResult") {
			const item = byCallId.get(m.toolCallId);
			if (item?.tool) item.tool.output = extractText(m.content);
		}
	}
	return { items, tokens, cost };
}

/** pi's usage: every token the request read or wrote, cached ones included (like Claude Code's count) */
export function usageTokens(u: any): number {
	return u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/** What to do when pi can't get through: this agent stays on pi, so start one elsewhere. */
/** What to do when pi isn't there at all (an agent started on pi before vigent stopped bundling it, say). */
export const PI_MISSING_HINT =
	"this agent runs on pi, which isn't installed. Install pi and send again, or press Esc and type :new <task> to start an agent on your default engine (:engine picks it, e.g. Claude Code or Codex); :kill removes this one.";

export const PI_KEY_HINT =
	"this agent runs on pi, and pi has no working API key. Agents keep the engine they started on: press Esc and type :new <task> to start one on the default engine (:engine picks it, e.g. Claude Code or Codex with your existing login); :kill removes this one.";

/**
 * The error of a reply whose request failed (pi ends it with stopReason
 * "error" and an errorMessage), with a hint when the key or login was refused.
 */
export function piError(message: any): string | undefined {
	if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
	const text = String(message.errorMessage ?? "").trim() || "the request failed";
	const auth = /\b(401|403)\b|auth|api[ _-]?key|unauthori[sz]ed|forbidden|credential|expired|login/i.test(text);
	return auth ? `error: ${text}\n${PI_KEY_HINT}` : `error: ${text}`;
}

export function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

export function summarizeArgs(args: any): string {
	if (!args) return "";
	if (typeof args === "string") return args.slice(0, 80);
	const v = args.command ?? args.path ?? args.file_path ?? args.filePath ?? JSON.stringify(args);
	return String(v).slice(0, 80);
}

/** ~/.pi/agent/extensions/guard.ts → extensions/guard.ts */
export function shortExtPath(p: unknown): string {
	const parts = String(p ?? "extension").split(/[\\/]/);
	return parts.slice(-2).join("/");
}
