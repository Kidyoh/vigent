/**
 * Session layer: one Session per agent.
 *
 * - PiSession runs a real pi coding agent in-process, with its read / write /
 *   edit / bash tools rooted in the agent's own git worktree.
 * - DemoSession replays a scripted transcript so the UI can be explored
 *   without API keys.
 */
import type { EngineId } from "./engines.js";
import { flattenTree, type TreeGlyphs, type TreeRow } from "./tree.js";
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
	items: TranscriptItem[] = [];
	tokens = 0;
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

	/** Continue: the next queued prompt, or ask the agent to pick up where it stopped. */
	resume() {
		if (this.state !== "paused") return;
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

// ---------------------------------------------------------------------------
// Pi session: real engine, in-process, working inside the agent's worktree
// ---------------------------------------------------------------------------

export interface PiSessionOptions {
	/** where the agent's tools run: its worktree, or your checkout without one */
	cwd: string;
	worktree?: WorktreeInfo;
	/** a pi-ai Model object; overrides the model id (used by tests) */
	modelObject?: unknown;
	/** pi AuthStorage; default: pi's own (~/.pi/agent/auth.json and env keys) */
	authStorage?: unknown;
	/** pi's config dir; default ~/.pi/agent */
	agentDir?: string;
	/** keep the conversation in this folder so the agent survives a restart (default: memory only) */
	sessionDir?: string;
	/** thinking level to start with: off, minimal, low, medium, high, xhigh */
	effort?: string;
}

export class PiSession extends Session {
	private session: any;
	readonly ready: Promise<void>;
	readonly cwd: string;

	constructor(name: string, model: string, private opts: PiSessionOptions) {
		super(name, model, opts.worktree);
		this.cwd = opts.cwd;
		this.effort = opts.effort;
		this.ready = this.init();
	}

	private async init() {
		const sdk = await import("@mariozechner/pi-coding-agent");
		const sessionManager = this.opts.sessionDir
			? sdk.SessionManager.continueRecent(this.cwd, this.opts.sessionDir)
			: sdk.SessionManager.inMemory();
		const resuming = sessionManager.buildSessionContext().messages.length > 0;
		let model = this.opts.modelObject;
		if (!model && !resuming) {
			model = await piModel(this.model); // undefined: let pi pick its default
		}
		// a resumed conversation keeps the model it was saved with, unless one is given
		const { session } = await sdk.createAgentSession({
			cwd: this.cwd,
			...(this.effort ? { thinkingLevel: this.effort as any } : {}),
			...(model ? { model: model as any } : {}),
			sessionManager,
			...(this.opts.authStorage ? { authStorage: this.opts.authStorage as any } : {}),
			...(this.opts.agentDir ? { agentDir: this.opts.agentDir } : {}),
		});
		this.session = session;
		if (resuming) {
			const restored = itemsFromMessages(session.messages ?? []);
			this.items.push(...restored.items);
			this.tokens += restored.tokens;
			this.pushInfo(`resumed: ${restored.items.filter((i) => i.kind === "user").length} earlier prompts`);
			this.refreshStat(0);
		}
		session.subscribe((event: any) => this.onEvent(event));
	}

	/** the run ended on a failed request (shown as an error, not as silence) */
	private failed = false;

	private onEvent(event: any) {
		switch (event.type) {
			case "agent_start":
				this.failed = false;
				this.setState("running");
				break;
			case "agent_end":
				this.setState(this.failed ? "error" : "idle");
				this.refreshStat(0);
				break;
			case "message_start": {
				if (event.message?.role === "assistant") {
					this.items.push({ kind: "agent", text: "", streaming: true });
					this.emit();
				}
				break;
			}
			case "message_update": {
				const last = this.items[this.items.length - 1];
				if (last?.kind === "agent" && event.message?.content) {
					last.text = extractText(event.message.content);
					this.emit();
				}
				break;
			}
			case "message_end": {
				const last = this.items[this.items.length - 1];
				if (last?.kind === "agent") {
					if (event.message?.content) last.text = extractText(event.message.content);
					last.streaming = false;
					const usage = event.message?.usage;
					if (usage) this.tokens += (usage.input ?? 0) + (usage.output ?? 0);
					if (!last.text) this.items.pop(); // a turn that only called tools
					this.emit();
				}
				// a failed request ends the reply with an error instead of throwing: say so
				const err = piError(event.message);
				if (err) {
					this.failed = true;
					this.pushInfo(err);
				}
				break;
			}
			case "tool_execution_start": {
				this.items.push({
					kind: "tool",
					text: "",
					tool: { name: event.toolName, summary: summarizeArgs(event.args), output: "", folded: true },
				});
				this.emit();
				break;
			}
			case "tool_execution_end": {
				const item = [...this.items].reverse().find((i) => i.kind === "tool" && i.tool?.name === event.toolName);
				if (item?.tool) {
					item.tool.output = extractText(event.result?.content ?? []) || JSON.stringify(event.result ?? "");
					this.emit();
				}
				this.refreshStat();
				break;
			}
		}
	}

	async setModel(model: string | undefined): Promise<void> {
		if (!model || model === "default") return;
		const m = await piModel(model);
		if (!m) throw new Error(`pi doesn't know the model '${model}' (provider/model, e.g. anthropic/claude-sonnet-4-5)`);
		await this.ready;
		await this.session.setModel(m);
		this.model = model;
		this.emit();
	}

	async setEffort(effort: string | undefined): Promise<void> {
		await this.ready;
		const level = !effort || effort === "default" ? "off" : effort;
		this.session.setThinkingLevel(level);
		this.effort = level === "off" ? undefined : level;
		this.emit();
	}

	tree(glyphs?: TreeGlyphs): TreeRow[] | undefined {
		const sm = this.session?.sessionManager;
		if (!sm) return undefined;
		return flattenTree(sm.getTree(), sm.getLeafId(), glyphs);
	}

	async navigate(id: string): Promise<{ editorText?: string }> {
		await this.ready;
		if (this.state === "running") throw new Error(`'${this.name}' is running; wait for it or :pause it first`);
		await this.session.agent?.waitForIdle?.();
		const r = await this.session.navigateTree(id);
		if (r.cancelled) throw new Error("cancelled");
		// the transcript shows the branch the agent is on now
		this.items = itemsFromMessages(this.session.messages ?? []).items;
		this.emit();
		return { editorText: r.editorText };
	}

	send(text: string): void {
		this.pushUser(text);
		this.setState("running");
		this.ready
			// pi reports agent_end a moment before it accepts the next prompt (queued prompts hit this)
			.then(() => this.session.agent?.waitForIdle?.())
			.then(() => this.session.prompt(text))
			.catch((err: any) => {
				const text = String(err?.message ?? err);
				// pi's own advice (/login, its docs paths) is for pi's TUI, not vigent: keep its first line
				const key = /api key|login|auth/i.test(text);
				this.pushInfo(`error: ${key ? text.split("\n")[0] : text}`);
				if (key) this.pushInfo(PI_KEY_HINT);
				this.setState("error");
			});
	}

	abort(): void {
		this.session?.abort?.();
		this.setState("idle");
	}

	dispose() {
		super.dispose();
		this.session?.dispose?.();
	}
}

/** Rebuild the transcript from pi's saved messages: prompts, replies, and tool calls with their output. */
export function itemsFromMessages(messages: any[]): { items: TranscriptItem[]; tokens: number } {
	const items: TranscriptItem[] = [];
	const byCallId = new Map<string, TranscriptItem>();
	let tokens = 0;
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
			if (m.usage) tokens += (m.usage.input ?? 0) + (m.usage.output ?? 0);
			const err = piError(m);
			if (err) items.push({ kind: "info", text: err });
		} else if (m?.role === "toolResult") {
			const item = byCallId.get(m.toolCallId);
			if (item?.tool) item.tool.output = extractText(m.content);
		}
	}
	return { items, tokens };
}

/** What to do when pi can't get through: this agent stays on pi, so start one elsewhere. */
export const PI_KEY_HINT =
	"this agent runs on pi, and pi has no working API key. Agents keep the engine they started on: :new <task> starts one on the default engine (:engine picks it, e.g. Claude Code or Codex with your existing login), and :kill removes this one.";

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

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

function summarizeArgs(args: any): string {
	if (!args) return "";
	if (typeof args === "string") return args.slice(0, 80);
	const v = args.command ?? args.path ?? args.file_path ?? args.filePath ?? JSON.stringify(args);
	return String(v).slice(0, 80);
}

/** A pi-ai model from "provider/model", or a bare id (Anthropic's). Undefined when pi doesn't know it. */
export async function piModel(id: string): Promise<unknown> {
	const ai: any = await import("@mariozechner/pi-ai");
	const slash = id.indexOf("/");
	const [provider, modelId] = slash > 0 ? [id.slice(0, slash), id.slice(slash + 1)] : ["anthropic", id];
	try {
		return ai.getModel(provider, modelId) ?? undefined;
	} catch {
		return undefined;
	}
}
