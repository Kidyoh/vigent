/**
 * Session layer: one Session per agent.
 *
 * - PiSession drives a real pi Agent (@mariozechner/pi-agent-core) in-process.
 * - DemoSession replays a scripted transcript so the UI can be explored
 *   without API keys.
 */

export type SessionState = "running" | "waiting" | "idle" | "error";

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

	constructor(
		public name: string,
		public model: string,
		public worktree?: string,
	) {}

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

	setState(s: SessionState) {
		this.state = s;
		this.emit();
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
// Pi session — real engine, in-process
// ---------------------------------------------------------------------------

export class PiSession extends Session {
	private agent: any;
	private ready: Promise<void>;

	constructor(name: string, model: string, worktree?: string) {
		super(name, model, worktree);
		this.ready = this.init();
	}

	private async init() {
		const { Agent } = await import("@mariozechner/pi-agent-core");
		const ai = await import("@mariozechner/pi-ai");
		ai.registerBuiltInApiProviders();
		let model: any;
		try {
			model = (ai as any).getModel("anthropic", this.model);
		} catch {
			model = undefined;
		}
		this.agent = new Agent({
			initialState: {
				systemPrompt:
					"You are a coding agent running inside vigent, a vim-style terminal orchestrator. Be concise.",
				...(model ? { model } : {}),
			} as any,
		});
		this.agent.subscribe((event: any) => this.onEvent(event));
	}

	private onEvent(event: any) {
		switch (event.type) {
			case "agent_start":
				this.setState("running");
				break;
			case "agent_end":
				this.setState("idle");
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
					this.emit();
				}
				break;
			}
			case "tool_execution_start": {
				this.items.push({
					kind: "tool",
					text: "",
					tool: {
						name: event.toolName,
						summary: summarizeArgs(event.args),
						output: "",
						folded: true,
					},
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
				break;
			}
		}
	}

	send(text: string): void {
		this.pushUser(text);
		this.setState("running");
		this.ready
			.then(() => this.agent.prompt(text))
			.catch((err: any) => {
				this.pushInfo(`error: ${err?.message ?? err}`);
				this.setState("error");
			});
	}

	abort(): void {
		this.agent?.abort?.();
		this.setState("idle");
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
