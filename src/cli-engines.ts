/**
 * Agents run by a coding-agent CLI you already have: Claude Code, Codex or
 * OpenCode.
 *
 * vigent starts the CLI once per prompt in the agent's worktree, in its
 * non-interactive JSON mode, and turns the events it prints into the
 * transcript. Each CLI keeps its own conversation; vigent only remembers the
 * id it prints and passes it back to resume. The CLI uses its own login:
 * vigent never reads its credentials.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { expandPrompt } from "./attach.js";
import { CUSTOM_ENGINES, type CustomEngine, ENGINE_BINS, ENGINE_NAMES, type EngineId } from "./engines.js";
import { Session, type TranscriptItem } from "./session.js";
import type { WorktreeInfo } from "./worktree.js";

export type CliEngineId = Exclude<EngineId, "pi">;

/** What a CLI's JSON events mean to the transcript. */
export type CliEvent =
	| { type: "session"; id: string }
	| { type: "model"; model: string }
	/** a piece of the reply being written */
	| { type: "text_delta"; text: string }
	/** a finished reply (replaces what was streamed for it) */
	| { type: "text"; text: string }
	/** a tool call; the same id again updates the line it started */
	| { type: "tool"; id?: string; name: string; summary: string }
	| { type: "tool_result"; id?: string; output: string }
	/** the model started or stopped thinking */
	| { type: "thinking"; active: boolean }
	| { type: "usage"; tokens: number; cost?: number }
	| { type: "error"; message: string }
	/** tools the CLI's permission settings refused to run (Claude Code's permission_denials) */
	| { type: "denied"; tools: Denial[] }
	| { type: "done"; ok: boolean; error?: string };

/** A tool call the CLI refused because its permission settings don't allow it. */
export interface Denial {
	name: string;
	input?: any;
}

export interface CliRunOptions {
	model?: string;
	/** reasoning effort: claude --effort, codex model_reasoning_effort, opencode --variant */
	effort?: string;
	/** the CLI's conversation id, to continue it */
	resumeId?: string;
	cwd: string;
	/** extra arguments from config ([engines.<id>] args) */
	extraArgs?: string[];
	/** files attached with `@path` (OpenCode takes them with -f) */
	files?: string[];
	/** Claude Code permission rules allowed for this run (--allowedTools) */
	allowedTools?: string[];
}

export interface CliAdapter {
	id: CliEngineId;
	bin: string;
	/** default extra arguments, replaced by [engines.<id>] args */
	defaultArgs: string[];
	args(prompt: string, o: CliRunOptions): string[];
	/** a fresh parser for one run (parsers keep a little state) */
	parser(): (event: any) => CliEvent[];
	/** it prints plain text, not JSON events: every line goes into the reply */
	raw?: boolean;
}

// ---------------------------------------------------------------------------
// Claude Code: claude -p --output-format stream-json
// ---------------------------------------------------------------------------

export const claudeAdapter: CliAdapter = {
	id: "claude",
	bin: ENGINE_BINS.claude,
	// -p can't ask before a tool runs; edits are allowed, other tools follow your Claude Code settings
	defaultArgs: ["--permission-mode", "acceptEdits"],
	args(prompt, o) {
		return [
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			...(o.extraArgs ?? this.defaultArgs),
			...(o.allowedTools?.length ? ["--allowedTools", ...o.allowedTools] : []),
			...(o.model ? ["--model", o.model] : []),
			...(o.effort ? ["--effort", o.effort] : []),
			...(o.resumeId ? ["--resume", o.resumeId] : []),
			"--",
			prompt,
		];
	},
	parser() {
		let thinkingBlock: number | undefined;
		return (e) => {
			if (!e || typeof e !== "object") return [];
			// a subagent's own messages: only its result reaches the transcript
			if (e.parent_tool_use_id) return [];
			const out: CliEvent[] = [];
			switch (e.type) {
				case "system":
					if (e.subtype === "init") {
						if (e.session_id) out.push({ type: "session", id: e.session_id });
						if (e.model) out.push({ type: "model", model: e.model });
					}
					break;
				case "stream_event": {
					const ev = e.event ?? {};
					const block = ev.content_block;
					if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
						out.push({ type: "text_delta", text: ev.delta.text });
					} else if (ev.type === "content_block_start" && block?.type === "tool_use") {
						// the input is still being written; the assistant event that follows fills it in
						out.push({ type: "tool", id: block.id, name: block.name, summary: "" });
					} else if (ev.type === "content_block_start" && block?.type === "thinking") {
						thinkingBlock = ev.index;
						out.push({ type: "thinking", active: true });
					} else if (ev.type === "content_block_stop" && thinkingBlock !== undefined && ev.index === thinkingBlock) {
						thinkingBlock = undefined;
						out.push({ type: "thinking", active: false });
					}
					break;
				}
				case "assistant":
					for (const b of contentOf(e.message)) {
						if (b?.type === "text" && b.text) out.push({ type: "text", text: b.text });
						else if (b?.type === "tool_use") out.push({ type: "tool", id: b.id, name: b.name, summary: summarize(b.input) });
					}
					break;
				case "user":
					for (const b of contentOf(e.message)) {
						if (b?.type === "tool_result") out.push({ type: "tool_result", id: b.tool_use_id, output: textOf(b.content) });
					}
					break;
				case "result": {
					const u = e.usage ?? {};
					const tokens =
						(u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
					const cost = typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined;
					if (tokens || cost !== undefined) out.push({ type: "usage", tokens, ...(cost !== undefined ? { cost } : {}) });
					if (e.session_id) out.push({ type: "session", id: e.session_id });
					if (Array.isArray(e.permission_denials) && e.permission_denials.length) {
						out.push({
							type: "denied",
							tools: e.permission_denials
								.filter((d: any) => d && typeof d.tool_name === "string")
								.map((d: any) => ({ name: d.tool_name, input: d.tool_input })),
						});
					}
					const ok = !e.is_error && e.subtype === "success";
					out.push({ type: "done", ok, ...(ok ? {} : { error: String(e.result ?? e.errors?.join?.("; ") ?? e.subtype ?? "failed") }) });
					break;
				}
			}
			return out;
		};
	},
};

// ---------------------------------------------------------------------------
// Codex: codex exec --json
// ---------------------------------------------------------------------------

export const codexAdapter: CliAdapter = {
	id: "codex",
	bin: ENGINE_BINS.codex,
	// edits and commands inside the worktree, nothing outside it
	defaultArgs: ["-c", 'sandbox_mode="workspace-write"'],
	args(prompt, o) {
		return [
			"exec",
			...(o.resumeId ? ["resume"] : []),
			"--json",
			"--skip-git-repo-check",
			...(o.extraArgs ?? this.defaultArgs),
			...(o.model ? ["-m", o.model] : []),
			...(o.effort ? ["-c", `model_reasoning_effort="${o.effort}"`] : []),
			...(o.resumeId ? [o.resumeId] : []),
			"--",
			prompt,
		];
	},
	parser() {
		let lastError: string | undefined;
		const started = new Set<string>();
		const tool = (item: any): CliEvent | undefined => {
			switch (item.type) {
				case "command_execution":
					return { type: "tool", id: item.id, name: "bash", summary: shellCommand(item.command) };
				case "file_change":
					return {
						type: "tool",
						id: item.id,
						name: "edit",
						summary: (item.changes ?? []).map((c: any) => `${c.kind === "add" ? "+" : c.kind === "delete" ? "-" : ""}${c.path}`).join(", "),
					};
				case "mcp_tool_call":
					return { type: "tool", id: item.id, name: [item.server, item.tool].filter(Boolean).join("."), summary: summarize(item.arguments) };
				case "web_search":
					return { type: "tool", id: item.id, name: "web_search", summary: String(item.query ?? "") };
			}
			return undefined;
		};
		return (e) => {
			if (!e || typeof e !== "object") return [];
			const out: CliEvent[] = [];
			switch (e.type) {
				case "thread.started":
					if (e.thread_id) out.push({ type: "session", id: e.thread_id });
					break;
				case "item.started": {
					const t = e.item && tool(e.item);
					if (t) {
						started.add(e.item.id);
						out.push(t);
					}
					break;
				}
				case "item.completed": {
					const item = e.item ?? {};
					if (item.type === "agent_message" && item.text) {
						out.push({ type: "text", text: item.text });
						break;
					}
					const t = tool(item);
					if (!t) break;
					if (!started.has(item.id)) out.push(t);
					const output =
						item.type === "command_execution"
							? `${String(item.aggregated_output ?? "").trimEnd()}${item.exit_code ? `\n(exit ${item.exit_code})` : ""}`.trim()
							: item.type === "mcp_tool_call"
								? textOf(item.result?.content ?? item.error?.message ?? "")
								: item.status === "failed"
									? "failed"
									: "";
					out.push({ type: "tool_result", id: item.id, output });
					break;
				}
				case "turn.completed": {
					const u = e.usage ?? {};
					const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
					if (tokens) out.push({ type: "usage", tokens });
					out.push({ type: "done", ok: true });
					break;
				}
				case "turn.failed":
					out.push({ type: "done", ok: false, error: e.error?.message ?? lastError ?? "turn failed" });
					break;
				case "error":
					// "Reconnecting... 2/5" is codex retrying; only the final error matters
					if (typeof e.message === "string" && !/^Reconnecting\.\.\./.test(e.message)) lastError = e.message;
					break;
			}
			return out;
		};
	},
};

// ---------------------------------------------------------------------------
// OpenCode: opencode run --format json
// ---------------------------------------------------------------------------

export const opencodeAdapter: CliAdapter = {
	id: "opencode",
	bin: ENGINE_BINS.opencode,
	defaultArgs: [],
	args(prompt, o) {
		return [
			"run",
			"--format",
			"json",
			"--dir",
			o.cwd,
			...(o.extraArgs ?? this.defaultArgs),
			...(o.model ? ["-m", o.model] : []),
			...(o.effort ? ["--variant", o.effort] : []),
			...(o.resumeId ? ["--session", o.resumeId] : []),
			...(o.files ?? []).flatMap((f) => ["-f", f]),
			"--",
			prompt,
		];
	},
	parser() {
		let sessionId: string | undefined;
		return (e) => {
			if (!e || typeof e !== "object") return [];
			const out: CliEvent[] = [];
			if (e.sessionID && e.sessionID !== sessionId) {
				sessionId = e.sessionID;
				out.push({ type: "session", id: e.sessionID });
			}
			const part = e.part ?? {};
			switch (e.type) {
				case "text":
					if (part.text?.trim()) out.push({ type: "text", text: part.text.trim() });
					break;
				case "tool_use": {
					const st = part.state ?? {};
					out.push({ type: "tool", id: part.callID ?? part.id, name: part.tool ?? "tool", summary: st.title || summarize(st.input) });
					out.push({ type: "tool_result", id: part.callID ?? part.id, output: String(st.output ?? st.error ?? "") });
					break;
				}
				case "step_finish": {
					const t = part.tokens ?? {};
					const tokens = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
					const cost = typeof part.cost === "number" ? part.cost : undefined;
					if (tokens || cost !== undefined) out.push({ type: "usage", tokens, ...(cost !== undefined ? { cost } : {}) });
					break;
				}
				case "error": {
					const err = e.error ?? {};
					out.push({ type: "error", message: String(err.data?.message ?? err.message ?? err.name ?? "error") });
					break;
				}
			}
			return out;
		};
	},
};

// ---------------------------------------------------------------------------
// Gemini CLI: gemini -o stream-json -p <prompt>
// (events: init, message, tool_use, tool_result, error, result; see gemini-cli's
// packages/core/src/output/types.ts)
// ---------------------------------------------------------------------------

export const geminiAdapter: CliAdapter = {
	id: "gemini",
	bin: ENGINE_BINS.gemini,
	// file edits go ahead; other tools follow your Gemini CLI settings (headless can't ask)
	defaultArgs: ["--approval-mode", "auto_edit"],
	args(prompt, o) {
		return [
			"--output-format",
			"stream-json",
			...(o.extraArgs ?? this.defaultArgs),
			...(o.model ? ["--model", o.model] : []),
			...(o.resumeId ? ["--resume", o.resumeId] : []),
			"--prompt",
			prompt,
		];
	},
	parser() {
		return (e) => {
			if (!e || typeof e !== "object") return [];
			const out: CliEvent[] = [];
			switch (e.type) {
				case "init":
					if (e.session_id) out.push({ type: "session", id: e.session_id });
					if (e.model) out.push({ type: "model", model: e.model });
					break;
				case "message":
					if (e.role === "assistant" && typeof e.content === "string") out.push(e.delta ? { type: "text_delta", text: e.content } : { type: "text", text: e.content });
					break;
				case "tool_use":
					out.push({ type: "tool", id: e.tool_id, name: String(e.tool_name ?? "tool"), summary: summarize(e.parameters) });
					break;
				case "tool_result":
					out.push({ type: "tool_result", id: e.tool_id, output: String(e.output ?? e.error?.message ?? e.status ?? "") });
					break;
				case "error":
					if (e.severity === "error" && e.message) out.push({ type: "error", message: String(e.message) });
					break;
				case "result": {
					const st = e.stats ?? {};
					const tokens = st.total_tokens ?? (st.input_tokens ?? 0) + (st.output_tokens ?? 0);
					if (tokens) out.push({ type: "usage", tokens });
					const ok = e.status === "success";
					out.push({ type: "done", ok, ...(ok ? {} : { error: String(e.error?.message ?? "failed") }) });
					break;
				}
			}
			return out;
		};
	},
};

// ---------------------------------------------------------------------------
// Cursor CLI: cursor-agent -p --output-format stream-json
// (events: system/init, user, assistant, tool_call started/completed, result)
// ---------------------------------------------------------------------------

/** Cursor names a tool call by its key: { readToolCall: {...} } is "read"; others are { function: { name } }. */
function cursorTool(call: any): { name: string; args: any; result: any } {
	if (call?.function) {
		let args = call.function.arguments;
		try {
			if (typeof args === "string") args = JSON.parse(args);
		} catch {
			// keep the string
		}
		return { name: String(call.function.name ?? "tool"), args, result: call.result };
	}
	const key = Object.keys(call ?? {}).find((k) => k.endsWith("ToolCall")) ?? Object.keys(call ?? {})[0] ?? "tool";
	const body = call?.[key] ?? {};
	return { name: key.replace(/ToolCall$/, ""), args: body.args, result: body.result };
}

export const cursorAdapter: CliAdapter = {
	id: "cursor",
	bin: ENGINE_BINS.cursor,
	// the agent works in its own worktree: let it edit and run commands there (headless can't ask)
	defaultArgs: ["--force"],
	args(prompt, o) {
		return [
			"--print",
			"--output-format",
			"stream-json",
			...(o.extraArgs ?? this.defaultArgs),
			...(o.model ? ["--model", o.model] : []),
			...(o.resumeId ? ["--resume", o.resumeId] : []),
			prompt,
		];
	},
	parser() {
		return (e) => {
			if (!e || typeof e !== "object") return [];
			const out: CliEvent[] = [];
			switch (e.type) {
				case "system":
					if (e.subtype === "init") {
						if (e.session_id) out.push({ type: "session", id: e.session_id });
						if (e.model) out.push({ type: "model", model: e.model });
					}
					break;
				case "assistant": {
					const text = contentOf(e.message)
						.filter((b: any) => b?.type === "text" && b.text)
						.map((b: any) => b.text)
						.join("");
					// with --stream-partial-output, pieces carry timestamp_ms; the flushes after them repeat the text
					if (text) out.push(e.timestamp_ms && !e.model_call_id ? { type: "text_delta", text } : { type: "text", text });
					break;
				}
				case "tool_call": {
					const t = cursorTool(e.tool_call);
					if (e.subtype === "started") out.push({ type: "tool", id: e.call_id, name: t.name, summary: summarize(t.args) });
					else if (e.subtype === "completed") {
						const r = t.result;
						const output = r?.success?.content ?? r?.success?.stdout ?? r?.error?.message ?? (r ? JSON.stringify(r.success ?? r) : "");
						out.push({ type: "tool_result", id: e.call_id, output: String(output) });
					}
					break;
				}
				case "result": {
					if (e.session_id) out.push({ type: "session", id: e.session_id });
					const ok = !e.is_error && e.subtype === "success";
					out.push({ type: "done", ok, ...(ok ? {} : { error: String(e.result ?? e.subtype ?? "failed") }) });
					break;
				}
			}
			return out;
		};
	},
};

export const CLI_ADAPTERS: Record<CliEngineId, CliAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	opencode: opencodeAdapter,
	gemini: geminiAdapter,
	cursor: cursorAdapter,
};

/**
 * An engine from your config: its command, with {prompt} and {model} filled
 * in, read as plain text or as the JSON of a CLI vigent already knows.
 */
export function customAdapter(e: CustomEngine): CliAdapter {
	const json = e.output === "text" ? undefined : CLI_ADAPTERS[e.output];
	return {
		id: e.id,
		bin: e.command[0],
		defaultArgs: [],
		raw: !json,
		args(prompt, o) {
			const fill = (a: string) => a.split("{prompt}").join(prompt).split("{model}").join(o.model ?? "").split("{id}").join(o.resumeId ?? "");
			const rest = e.command.slice(1);
			const placed = rest.some((a) => a.includes("{prompt}"));
			return [
				...rest.map(fill),
				...(o.extraArgs ?? []),
				...(o.model && e.modelArgs ? e.modelArgs.map(fill) : []),
				...(o.resumeId && e.resumeArgs ? e.resumeArgs.map(fill) : []),
				...(placed ? [] : [prompt]),
			];
		},
		parser: () => {
			if (!json) return () => [];
			const parse = json.parser();
			// without resume_args vigent can't pass a conversation back, so it doesn't keep one
			return e.resumeArgs ? parse : (ev) => parse(ev).filter((x) => x.type !== "session");
		},
	};
}

/** The adapter for a built-in CLI or an engine from your config. */
export function adapterFor(engine: CliEngineId): CliAdapter {
	const custom = CUSTOM_ENGINES.get(engine);
	if (custom) return customAdapter(custom);
	const a = CLI_ADAPTERS[engine];
	if (!a) throw new Error(`unknown engine '${engine}'`);
	return a;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface CliSessionOptions {
	cwd: string;
	worktree?: WorktreeInfo;
	/** continue this CLI conversation (restored agents) */
	resumeId?: string;
	/** replaces the adapter's default extra arguments */
	extraArgs?: string[];
	/** reasoning effort to start with */
	effort?: string;
	/** the CLI to run; default: the engine's usual command on PATH */
	bin?: string;
	/** the CLI's environment; a function is asked at each run (what detection learns can change it) */
	env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
	/** called when the CLI reports its conversation id, so it can be saved */
	onResumeId?: (id: string) => void;
	/** permission rules every run may use ([engines.claude] allow); asked at each run */
	allow?: () => string[] | undefined;
	/** when the CLI refuses a tool, ask to allow it and retry ([engines.claude] ask; opt-in) */
	ask?: boolean;
	/** "always allow" was picked: keep these rules ([engines.claude] allow) */
	onAlwaysAllow?: (rules: string[]) => void;
}

/** What you pick when an agent was refused a tool: allow it for one retry, for good, or not. */
export type AllowChoice = "once" | "always" | undefined;

export class CliSession extends Session {
	declare engine: CliEngineId;
	readonly cwd: string;
	resumeId?: string;
	private adapter: CliAdapter;
	private child?: ChildProcess;
	private aborted = false;
	/** the model the user asked for; undefined = the CLI's own default */
	private requestedModel?: string;
	/** asks you whether to allow tools the CLI refused (set by the app when [engines.claude] ask is on) */
	approver?: (blocked: Denial[], rules: string[]) => Promise<AllowChoice>;

	constructor(name: string, engine: CliEngineId, model: string | undefined, private opts: CliSessionOptions) {
		super(name, model ?? ENGINE_NAMES[engine], opts.worktree);
		this.engine = engine;
		this.adapter = adapterFor(engine);
		this.cwd = opts.cwd;
		this.requestedModel = model;
		this.effort = opts.effort;
		this.resumeId = opts.resumeId;
		if (opts.resumeId) {
			this.pushInfo(`continuing the ${ENGINE_NAMES[engine]} conversation ${opts.resumeId.slice(0, 8)}… (earlier messages live in ${ENGINE_NAMES[engine]}'s history)`);
			this.refreshStat(0);
		}
	}

	get engineName(): string {
		return ENGINE_NAMES[this.engine];
	}

	/** The model for the next prompt; undefined (or "default") = the CLI's own. */
	setModel(model: string | undefined): void {
		this.requestedModel = model && model !== "default" ? model : undefined;
		this.model = this.requestedModel ?? ENGINE_NAMES[this.engine];
		this.emit();
	}

	/** Reasoning effort for the next prompt; undefined = the CLI's own. */
	setEffort(effort: string | undefined): void {
		this.effort = effort && effort !== "default" ? effort : undefined;
		this.emit();
	}

	/** what was asked for (vs. what the CLI reported it used) */
	get chosenModel(): string | undefined {
		return this.requestedModel;
	}

	send(text: string): void {
		this.pushUser(text);
		this.run(text);
	}

	/** whether a refused tool can be asked about (opt-in, and only Claude Code reports them) */
	get asksToAllow(): boolean {
		return !!this.opts.ask && this.engine === "claude";
	}

	private setThinking(active: boolean): void {
		if (this.thinking === active) return;
		this.thinking = active;
		this.emit();
	}

	/** One run of the CLI; `once` are permission rules for this run only. */
	private run(text: string, once: string[] = []): void {
		this.setState("running");
		this.aborted = false;
		const attached = expandPrompt(text, this.adapter.id, this.cwd);
		if (attached.skipped.length) this.pushInfo(`not attached: ${attached.skipped.join(", ")}`);
		const args = this.adapter.args(attached.prompt, {
			cwd: this.cwd,
			files: attached.files,
			model: this.requestedModel,
			effort: this.effort,
			resumeId: this.resumeId,
			extraArgs: this.opts.extraArgs,
			allowedTools: [...new Set([...(this.opts.allow?.() ?? []), ...once])],
		});
		let child: ChildProcess;
		try {
			child = spawn(this.opts.bin ?? this.adapter.bin, args, {
				cwd: this.cwd,
				env: typeof this.opts.env === "function" ? this.opts.env() : (this.opts.env ?? process.env),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err: any) {
			this.fail(`couldn't start ${this.adapter.bin}: ${err?.message ?? err}`);
			return;
		}
		this.child = child;
		const parse = this.adapter.parser();
		let buf = "";
		let stderr = "";
		let result: Extract<CliEvent, { type: "done" }> | undefined;
		let lastError: string | undefined;
		let denied: Denial[] = [];
		const tools = new Map<string, TranscriptItem>();

		const handle = (ev: CliEvent) => {
			switch (ev.type) {
				case "session":
					if (ev.id !== this.resumeId) {
						this.resumeId = ev.id;
						this.opts.onResumeId?.(ev.id);
					}
					break;
				case "model":
					if (!this.requestedModel) this.model = ev.model;
					this.emit();
					break;
				case "text_delta": {
					const last = this.items.at(-1);
					if (last?.kind === "agent" && last.streaming) last.text += ev.text;
					else this.items.push({ kind: "agent", text: ev.text, streaming: true });
					this.emit();
					break;
				}
				case "text": {
					const last = this.items.at(-1);
					if (last?.kind === "agent" && last.streaming) {
						last.text = ev.text;
						last.streaming = false;
					} else this.items.push({ kind: "agent", text: ev.text });
					this.emit();
					break;
				}
				case "tool": {
					this.endStreaming();
					const summary = this.relative(ev.summary).slice(0, 80);
					const started = ev.id ? tools.get(ev.id) : undefined;
					if (started?.tool) {
						started.tool.summary = summary;
					} else {
						const item: TranscriptItem = { kind: "tool", text: "", tool: { name: ev.name, summary, output: "", folded: true } };
						this.items.push(item);
						if (ev.id) tools.set(ev.id, item);
					}
					this.emit();
					break;
				}
				case "thinking":
					this.setThinking(ev.active);
					break;
				case "tool_result": {
					const item = (ev.id && tools.get(ev.id)) || [...this.items].reverse().find((i) => i.kind === "tool");
					if (item?.tool) item.tool.output = ev.output;
					this.emit();
					this.refreshStat();
					break;
				}
				case "usage":
					this.tokens += ev.tokens;
					if (ev.cost !== undefined) this.cost = (this.cost ?? 0) + ev.cost;
					this.emit();
					break;
				case "error":
					lastError = ev.message;
					break;
				case "denied":
					denied = ev.tools;
					break;
				case "done":
					result = ev;
					break;
			}
		};

		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const rawLine = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				// a plain-text CLI: what it prints is the reply
				if (this.adapter.raw) {
					handle({ type: "text_delta", text: `${rawLine.replace(/\r$/, "")}\n` });
					continue;
				}
				const line = rawLine.trim();
				if (!line.startsWith("{")) continue;
				let json: unknown;
				try {
					json = JSON.parse(line);
				} catch {
					continue; // not an event (a stray log line)
				}
				for (const ev of parse(json)) handle(ev);
			}
		});
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			this.child = undefined;
			this.fail(
				err.code === "ENOENT"
					? `${this.adapter.bin} isn't installed (or isn't on PATH) · :checkhealth`
					: `${this.adapter.bin}: ${err.message}`,
			);
		});
		child.on("close", (code, signal) => {
			if (this.child !== child) return; // already failed to start
			this.child = undefined;
			this.setThinking(false);
			if (this.adapter.raw) {
				// the last line may not end with a newline; and no trailing blank lines in the reply
				if (buf) handle({ type: "text_delta", text: buf });
				buf = "";
				const last = this.items.at(-1);
				if (last?.kind === "agent" && last.streaming) last.text = last.text.trimEnd();
			} else if (buf.trim().startsWith("{")) {
				// the last event may not end with a newline
				try {
					for (const ev of parse(JSON.parse(buf.trim()))) handle(ev);
				} catch {
					// a cut-off line: nothing to read
				}
				buf = "";
			}
			this.endStreaming();
			this.refreshStat(0);
			if (this.aborted) {
				this.setState("idle");
				return;
			}
			const ok = result ? result.ok : code === 0 && !lastError;
			if (denied.length && this.blocked(denied)) return;
			if (ok) {
				this.setState("idle");
				return;
			}
			const why =
				result?.error ??
				lastError ??
				lastLines(stderr) ??
				(signal ? `stopped by ${signal}` : `exited with code ${code}`);
			this.fail(`${this.engineName}: ${why}`);
		});
	}

	/**
	 * The CLI refused some tools. Say which; with [engines.claude] ask on, ask
	 * whether to allow them and run again. True when it's now asking you.
	 */
	private blocked(denied: Denial[]): boolean {
		const what = [...new Set(denied.map((d) => this.relative(describeDenial(d))))];
		const rules = [...new Set(denied.map(allowRule))];
		this.pushInfo(`blocked by ${this.engineName}'s permissions: ${what.join(" · ")}`);
		if (!this.asksToAllow || !this.approver) {
			if (this.engine === "claude") this.pushInfo(`to allow it, in config.toml: [engines.claude] allow = ${JSON.stringify(rules)} (or ask = true, to be asked each time)`);
			return false;
		}
		this.setState("waiting");
		this.approver(denied, rules).then(
			(choice) => {
				if (this.state !== "waiting") return; // aborted, or a new prompt was sent meanwhile
				if (!choice) {
					this.pushInfo("left blocked");
					this.setState("idle");
					return;
				}
				if (choice === "always") this.opts.onAlwaysAllow?.(rules);
				this.pushInfo(`${choice === "always" ? "always allowed" : "allowed once"}: ${rules.join(", ")} · retrying`);
				this.run(`You now have permission to use ${rules.join(", ")}. Retry what was blocked, then carry on with the task.`, rules);
			},
			() => this.setState("idle"),
		);
		return true;
	}

	/** paths inside the agent's folder, shown relative to it */
	private relative(text: string): string {
		let out = text;
		for (const dir of new Set([this.cwd, safeRealpath(this.cwd)])) {
			if (dir) out = out.split(`${dir.replace(/\/+$/, "")}/`).join("");
		}
		return out;
	}

	private endStreaming() {
		const last = this.items.at(-1);
		if (last?.kind === "agent" && last.streaming) {
			last.streaming = false;
			if (!last.text) this.items.pop();
		}
	}

	private fail(message: string) {
		this.endStreaming();
		this.pushInfo(`error: ${message}`);
		this.setState("error");
	}

	abort(): void {
		const child = this.child;
		if (child) {
			this.aborted = true;
			child.kill("SIGINT");
			const t = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			}, 2000);
			t.unref();
		}
		this.setState("idle");
	}

	dispose() {
		super.dispose();
		if (this.child) {
			this.aborted = true;
			this.child.kill("SIGTERM");
		}
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function safeRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync(p);
	} catch {
		return undefined;
	}
}

/** A refused tool call, short: the command for Bash, the tool name and its target otherwise. */
export function describeDenial(d: Denial): string {
	if (d.name === "Bash" && typeof d.input?.command === "string") return d.input.command.replace(/\s+/g, " ").trim().slice(0, 80);
	const s = summarize(d.input);
	return s ? `${d.name} ${s}`.slice(0, 80) : d.name;
}

/**
 * The Claude Code permission rule that allows a refused call: `Bash(gh:*)`
 * for a command (its program, any arguments), the tool's name otherwise.
 */
export function allowRule(d: Denial): string {
	if (d.name === "Bash" && typeof d.input?.command === "string") {
		// skip leading VAR=value assignments; the program is the first word
		const words = d.input.command.trim().split(/\s+/).filter((w: string) => w);
		const prog = words.find((w: string) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
		const m = prog && /^[^\s;&|()<>`$'"]+/.exec(prog);
		if (m) return `Bash(${m[0]}:*)`;
		return "Bash";
	}
	return d.name;
}

function contentOf(message: any): any[] {
	return Array.isArray(message?.content) ? message.content : [];
}

function textOf(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

function summarize(args: any): string {
	if (!args) return "";
	if (typeof args === "string") return args.slice(0, 80);
	const v = args.command ?? args.file_path ?? args.filePath ?? args.path ?? args.pattern ?? args.url ?? args.description ?? JSON.stringify(args);
	return String(v).slice(0, 80);
}

/** codex reports commands as `/bin/bash -lc "npm test"` (or an argv array); show the command itself. */
function shellCommand(cmd: unknown): string {
	const parts = Array.isArray(cmd) ? cmd.map(String) : undefined;
	if (parts && parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(" ");
	const s = parts ? parts.join(" ") : String(cmd ?? "");
	const m = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(s);
	return m ? m[2] : s;
}

function lastLines(stderr: string): string | undefined {
	const lines = stderr
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !/^Reading additional input from stdin/.test(l) && !/^Warning: no stdin data/.test(l));
	return lines.length ? lines.slice(-2).join(" · ") : undefined;
}
