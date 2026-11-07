/**
 * Session layer: one Session per agent.
 *
 * - PiSession runs a real pi coding agent in-process, with its read / write /
 *   edit / bash tools rooted in the agent's own git worktree.
 * - DemoSession replays a scripted transcript so the UI can be explored
 *   without API keys.
 */
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
}

export class PiSession extends Session {
	private session: any;
	readonly ready: Promise<void>;
	readonly cwd: string;

	constructor(name: string, model: string, private opts: PiSessionOptions) {
		super(name, model, opts.worktree);
		this.cwd = opts.cwd;
		this.ready = this.init();
	}

	private async init() {
		const sdk = await import("@mariozechner/pi-coding-agent");
		let model = this.opts.modelObject;
		if (!model) {
			const ai = await import("@mariozechner/pi-ai");
			try {
				model = (ai as any).getModel("anthropic", this.model);
			} catch {
				model = undefined; // let pi pick its default
			}
		}
		const { session } = await sdk.createAgentSession({
			cwd: this.cwd,
			model: model as any,
			sessionManager: sdk.SessionManager.inMemory(),
			...(this.opts.authStorage ? { authStorage: this.opts.authStorage as any } : {}),
			...(this.opts.agentDir ? { agentDir: this.opts.agentDir } : {}),
		});
		this.session = session;
		session.subscribe((event: any) => this.onEvent(event));
	}

	private onEvent(event: any) {
		switch (event.type) {
			case "agent_start":
				this.setState("running");
				break;
			case "agent_end":
				this.setState("idle");
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

	send(text: string): void {
		this.pushUser(text);
		this.setState("running");
		this.ready
			.then(() => this.session.prompt(text))
			.catch((err: any) => {
				this.pushInfo(`error: ${err?.message ?? err}`);
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
