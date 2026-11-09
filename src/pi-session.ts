/**
 * A pi agent: your installed pi, in its RPC mode (`pi --mode rpc`).
 *
 * One long-running pi per agent, in the agent's worktree. pi runs its own
 * loop (tools, retries, compaction, extensions, skills, prompt templates);
 * vigent sends prompts over stdin and draws what pi streams back on stdout.
 * Extensions' dialogs (confirm, select, input) come over the same pipe and
 * vigent answers them, so pi's permission gate works as it does in pi.
 * The conversation lives in pi's session file, so the agent survives a
 * restart (`--session-dir <worktree's folder> --continue`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandPrompt } from "./attach.js";
import { piAgentDir } from "./engines.js";
import { PI_BIN, PI_INSTALL } from "./pi-cli.js";
import type { PiResources, PiUiHost } from "./pi-ui.js";
import {
	extractText,
	itemsFromMessages,
	PI_KEY_HINT,
	PI_MISSING_HINT,
	piError,
	Session,
	shortExtPath,
	summarizeArgs,
	type TranscriptItem,
	usageTokens,
} from "./session.js";
import { flattenTree, type TreeGlyphs, type TreeNodeLike, type TreeRow } from "./tree.js";
import type { WorktreeInfo } from "./worktree.js";

export interface PiSessionOptions {
	/** where the agent's tools run: its worktree, or your checkout without one */
	cwd: string;
	worktree?: WorktreeInfo;
	/** keep the conversation in this folder so the agent survives a restart (default: memory only) */
	sessionDir?: string;
	/** thinking level to start with: off, minimal, low, medium, high, xhigh */
	effort?: string;
	/** the pi to run (default: pi on PATH) */
	bin?: string;
	/** pi's environment (default: vigent's) */
	env?: NodeJS.ProcessEnv;
	/** extra arguments for pi ([engines.pi] args) */
	extraArgs?: string[];
}

interface Pending {
	resolve: (data: any) => void;
	reject: (err: Error) => void;
}

export class PiSession extends Session {
	ready: Promise<void>;
	readonly cwd: string;
	private child?: ChildProcess;
	private pending = new Map<string, Pending>();
	private seq = 0;
	private buf = "";
	private stderr = "";
	private sessionFile?: string;
	private commandList: any[] = [];
	private extensionErrors = new Map<string, string>();
	/** a run started since the last prompt went out (an extension command may run none) */
	private runStarted = false;
	/** the run ended on a failed request (shown as an error, not as silence) */
	private failed = false;
	private tools = new Map<string, TranscriptItem>();
	private disposed = false;

	constructor(name: string, model: string, private opts: PiSessionOptions) {
		super(name, model, opts.worktree);
		this.cwd = opts.cwd;
		this.effort = opts.effort;
		this.ready = this.start();
		this.ready.catch(() => {}); // reported where it's awaited, and in the transcript
	}

	private args(): string[] {
		const model = this.model && this.model !== "default" && this.model !== "pi" ? this.model : undefined;
		return [
			"--mode",
			"rpc",
			...(this.opts.sessionDir ? ["--session-dir", this.opts.sessionDir, "--continue"] : ["--no-session"]),
			...(model ? ["--model", model] : []),
			...(this.effort ? ["--thinking", this.effort] : []),
			...(this.opts.extraArgs ?? []),
		];
	}

	private start(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn(this.opts.bin ?? PI_BIN, this.args(), { cwd: this.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
			} catch (err: any) {
				reject(new Error(`couldn't start pi: ${err?.message ?? err}`));
				return;
			}
			this.child = child;
			this.buf = "";
			this.stderr = "";
			child.stdout!.setEncoding("utf8");
			child.stdout!.on("data", (d: string) => this.onData(d));
			child.stderr!.setEncoding("utf8");
			child.stderr!.on("data", (d: string) => {
				this.stderr = (this.stderr + d).slice(-4000);
			});
			child.stdin!.on("error", () => {}); // pi went away; 'exit' says so
			child.on("error", (err: NodeJS.ErrnoException) => {
				if (this.child === child) this.child = undefined;
				const why = err.code === "ENOENT" ? `pi isn't installed: ${PI_INSTALL}` : `couldn't start pi: ${err.message}`;
				this.lost(why);
				reject(new Error(why));
			});
			child.on("exit", (code, signal) => {
				if (this.child !== child) return;
				this.child = undefined;
				if (this.disposed) return;
				const tail = this.stderr.trim().split("\n").slice(-3).join("\n");
				const why = `pi stopped (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ""}`;
				this.lost(why);
				reject(new Error(why));
			});
			this.request({ type: "get_state" })
				.then(async (state) => {
					this.applyState(state);
					if (state?.messageCount > 0) {
						const { messages } = await this.request({ type: "get_messages" });
						const restored = itemsFromMessages(messages ?? []);
						this.items.push(...restored.items);
						this.tokens += restored.tokens;
						if (restored.cost !== undefined) this.cost = (this.cost ?? 0) + restored.cost;
						if (!this.quietResume) this.pushInfo(`resumed: ${restored.items.filter((i) => i.kind === "user").length} earlier prompts`);
						this.refreshStat(0);
					}
					this.quietResume = false;
					await this.loadCommands();
					resolve();
				})
				.catch(reject);
		});
	}

	/** pi exited or never started: fail what's waiting; the next prompt starts it again */
	private lost(why: string) {
		for (const p of this.pending.values()) p.reject(new Error(why));
		this.pending.clear();
		if (this.disposed) return;
		const text = `error: ${why}`;
		const hint = why.startsWith("pi isn't installed") ? PI_MISSING_HINT : undefined;
		// a prompt was waiting: answer it, every time (at startup, once is enough)
		const prompted = this.state === "running" || this.state === "waiting";
		if (prompted || !this.items.some((i) => i.kind === "info" && i.text === text)) {
			this.pushInfo(text);
			if (hint) this.pushInfo(hint);
		}
		if (prompted) this.setState("error");
	}

	private applyState(state: any) {
		if (!state) return;
		this.sessionFile = state.sessionFile ?? this.sessionFile;
		const m = state.model;
		if (m?.id && m.id !== "unknown" && (!this.model || this.model === "default" || this.model === "pi")) this.model = m.provider ? `${m.provider}/${m.id}` : m.id;
		if (state.thinkingLevel && state.thinkingLevel !== "off") this.effort = state.thinkingLevel;
		this.emit();
	}

	private async loadCommands() {
		try {
			const { commands } = await this.request({ type: "get_commands" });
			this.commandList = Array.isArray(commands) ? commands : [];
		} catch {
			// an older pi: :pi shows less
		}
	}

	/** Send a command and wait for its response. */
	private request(cmd: Record<string, unknown>): Promise<any> {
		const child = this.child;
		if (!child?.stdin?.writable) return Promise.reject(new Error("pi isn't running"));
		const id = `v${++this.seq}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			child.stdin!.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	private write(msg: Record<string, unknown>) {
		if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	/** pi's framing: JSON lines split on \n only (a JSON string may hold U+2028) */
	private onData(d: string) {
		this.buf += d;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, "");
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // not ours (a stray print)
			}
			if (msg.type === "response") {
				const p = msg.id ? this.pending.get(msg.id) : undefined;
				if (!p) continue;
				this.pending.delete(msg.id);
				if (msg.success === false) p.reject(new Error(String(msg.error ?? `pi refused ${msg.command}`)));
				else p.resolve(msg.data);
			} else if (msg.type === "extension_ui_request") {
				this.onUiRequest(msg);
			} else {
				this.onEvent(msg);
			}
		}
	}

	private onEvent(event: any) {
		switch (event.type) {
			case "agent_start":
				this.runStarted = true;
				this.failed = false;
				this.setState("running");
				break;
			case "agent_end":
				this.setState(this.failed ? "error" : "idle");
				this.refreshStat(0);
				this.request({ type: "get_state" }).then(
					(st) => this.applyState(st),
					() => {},
				);
				break;
			case "message_start":
				if (event.message?.role === "assistant") {
					this.items.push({ kind: "agent", text: "", streaming: true });
					this.emit();
				}
				break;
			case "message_update": {
				const last = this.items[this.items.length - 1];
				if (last?.kind === "agent" && last.streaming && event.message?.content) {
					last.text = extractText(event.message.content);
					this.emit();
				}
				break;
			}
			case "message_end": {
				if (event.message?.role !== "assistant") break;
				const last = this.items[this.items.length - 1];
				if (last?.kind === "agent" && last.streaming) {
					if (event.message.content) last.text = extractText(event.message.content);
					last.streaming = false;
					if (!last.text) this.items.pop(); // a turn that only called tools
				}
				const usage = event.message.usage;
				if (usage) {
					this.tokens += usageTokens(usage);
					if (typeof usage.cost?.total === "number") this.cost = (this.cost ?? 0) + usage.cost.total;
				}
				// a failed request ends the reply with an error instead of throwing: say so
				const err = piError(event.message);
				if (err) {
					this.failed = true;
					this.pushInfo(err);
				}
				this.emit();
				break;
			}
			case "tool_execution_start": {
				const item: TranscriptItem = { kind: "tool", text: "", tool: { name: event.toolName, summary: summarizeArgs(event.args), output: "", folded: true } };
				this.items.push(item);
				if (event.toolCallId) this.tools.set(event.toolCallId, item);
				this.emit();
				break;
			}
			case "tool_execution_update":
			case "tool_execution_end": {
				const item = this.tools.get(event.toolCallId) ?? [...this.items].reverse().find((i) => i.kind === "tool" && i.tool?.name === event.toolName);
				const end = event.type === "tool_execution_end";
				// updates carry the output so far (not a delta), so the line just shows the latest
				const result = end ? event.result : event.partialResult;
				if (item?.tool && result) {
					item.tool.output = extractText(result.content ?? []) || (end ? JSON.stringify(result) : item.tool.output);
					this.emit();
				}
				if (end) {
					this.tools.delete(event.toolCallId);
					this.refreshStat();
				}
				break;
			}
			case "auto_retry_start":
				this.pushInfo(`retrying (${event.attempt}/${event.maxAttempts}) after: ${oneLine(event.errorMessage)}`);
				break;
			case "auto_retry_end":
				if (!event.success && event.finalError) this.pushInfo(`gave up after ${event.attempt} tries: ${oneLine(event.finalError)}`);
				break;
			case "compaction_start":
				this.pushInfo(`compacting the conversation (${event.reason})…`);
				break;
			case "compaction_end":
				if (event.errorMessage) this.pushInfo(`compaction failed: ${oneLine(event.errorMessage)}`);
				else if (!event.aborted) this.pushInfo("conversation compacted");
				break;
			case "extension_error": {
				const where = `${shortExtPath(event.extensionPath)}${event.event ? `, ${event.event}` : ""}`;
				this.extensionErrors.set(String(event.extensionPath ?? "extension"), String(event.error ?? "failed"));
				this.pushInfo(`extension error (${where}): ${event.error}`);
				break;
			}
		}
	}

	/** where this agent's extensions show dialogs and messages (set by the app) */
	uiHost?: PiUiHost;
	/** statuses extensions keep up to date (ctx.ui.setStatus), shown in the winbar */
	extensionStatus = new Map<string, string>();

	/** with no screen to ask on: messages still reach the transcript, dialogs answer no */
	private fallbackUi: PiUiHost = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => this.pushInfo(message),
		setStatus: (key, text) => this.setExtensionStatus(key, text),
	};

	/** An extension asked something (or said something): answer the dialogs, show the rest. */
	private onUiRequest(req: any) {
		const host = this.uiHost ?? this.fallbackUi;
		const reply = (answer: Record<string, unknown>) => this.write({ type: "extension_ui_response", id: req.id, ...answer });
		const asked = (p: Promise<unknown>, key: "value" | "confirmed") => {
			const was = this.state;
			if (was === "running") this.setState("waiting");
			p.then(
				(v) => reply(v === undefined ? { cancelled: true } : { [key]: v }),
				() => reply({ cancelled: true }),
			).finally(() => {
				if (this.state === "waiting") this.setState(was);
			});
		};
		switch (req.method) {
			case "select":
				return asked(host.select(String(req.title ?? ""), (req.options ?? []).map(String)), "value");
			case "confirm":
				return asked(host.confirm(String(req.title ?? ""), String(req.message ?? "")).then(Boolean), "confirmed");
			case "input":
				return asked(host.input(String(req.title ?? ""), req.placeholder), "value");
			case "editor":
				return asked(host.input(String(req.title ?? ""), req.prefill), "value");
			case "notify":
				return host.notify(String(req.message ?? ""), req.notifyType === "error" || req.notifyType === "warning" ? req.notifyType : "info");
			case "setStatus":
				return host.setStatus(String(req.statusKey ?? "status"), req.statusText ? String(req.statusText) : undefined);
			default:
				// widgets, titles, editor text: pi's own TUI only
				return;
		}
	}

	setExtensionStatus(key: string, text: string | undefined) {
		if (text) this.extensionStatus.set(key, text);
		else this.extensionStatus.delete(key);
		this.emit();
	}

	/** What pi loaded for this agent: extensions, their commands, skills, prompt templates. */
	resources(): PiResources | undefined {
		if (!this.child && !this.commandList.length && !this.extensionErrors.size) return undefined;
		const cmds = this.commandList;
		const pathOf = (c: any) => String(c.sourceInfo?.path ?? c.path ?? "");
		const extPaths = [...new Set(cmds.filter((c) => c.source === "extension").map(pathOf).filter(Boolean))];
		return {
			extensions: [...extPaths.filter((p) => !this.extensionErrors.has(p)).map((p) => ({ path: p })), ...[...this.extensionErrors].map(([p, error]) => ({ path: p, error }))],
			commands: cmds.filter((c) => c.source === "extension").map((c) => ({ name: String(c.name), description: c.description })),
			skills: cmds.filter((c) => c.source === "skill").map((c) => ({ name: String(c.name).replace(/^skill:/, ""), description: c.description, path: pathOf(c) || undefined })),
			prompts: cmds.filter((c) => c.source === "prompt").map((c) => ({ name: String(c.name), description: c.description })),
			contextFiles: contextFiles(this.cwd, piAgentDir(this.opts.env ?? process.env)),
		};
	}

	/** Make sure pi is running (it starts again after it stopped; a saved conversation continues). */
	private alive(): Promise<void> {
		if (!this.child && !this.disposed) {
			this.ready = this.start();
			this.ready.catch(() => {});
		}
		return this.ready;
	}

	send(text: string): void {
		this.pushUser(text);
		this.setState("running");
		const attached = expandPrompt(text, "pi", this.cwd);
		if (attached.skipped.length) this.pushInfo(`not attached: ${attached.skipped.join(", ")}`);
		this.alive()
			.then(() => {
				this.runStarted = false;
				// pi reports agent_end a moment before it's idle: a prompt sent right then queues instead of failing
				return this.request({ type: "prompt", message: attached.prompt, streamingBehavior: "followUp" });
			})
			// an extension command (/name) runs no turn: nothing else will end it
			.then(() => this.request({ type: "get_state" }))
			.then((st) => {
				if (!this.runStarted && !st?.isStreaming && this.state === "running") this.setState("idle");
			})
			.catch((err: any) => {
				if (this.state === "error") return; // already said (pi stopped)
				const msg = String(err?.message ?? err);
				const key = /api key|login|auth|no model/i.test(msg);
				this.pushInfo(`error: ${key ? msg.split("\n")[0] : msg}`);
				if (key) this.pushInfo(PI_KEY_HINT);
				this.setState("error");
			});
	}

	abort(): void {
		this.request({ type: "abort" }).catch(() => {});
		this.setState("idle");
	}

	async setModel(model: string | undefined): Promise<void> {
		if (!model || model === "default") return;
		await this.alive();
		const slash = model.indexOf("/");
		let provider = slash > 0 ? model.slice(0, slash) : "";
		const modelId = slash > 0 ? model.slice(slash + 1) : model;
		if (!provider) {
			// a bare id: the provider pi has it under
			const { models } = await this.request({ type: "get_available_models" });
			const found = (models ?? []).find((m: any) => m.id === modelId);
			if (!found) throw new Error(`pi doesn't know the model '${model}' (provider/model, e.g. anthropic/claude-sonnet-4-5)`);
			provider = found.provider;
		}
		await this.request({ type: "set_model", provider, modelId });
		this.model = `${provider}/${modelId}`;
		this.emit();
	}

	async setEffort(effort: string | undefined): Promise<void> {
		await this.alive();
		const level = !effort || effort === "default" ? "off" : effort;
		await this.request({ type: "set_thinking_level", level });
		this.effort = level === "off" ? undefined : level;
		this.emit();
	}

	/** The conversation as a tree, read from pi's session file. */
	tree(glyphs?: TreeGlyphs): TreeRow[] | undefined {
		if (!this.sessionFile) return this.opts.sessionDir ? [] : undefined;
		const t = readSessionTree(this.sessionFile);
		return t ? flattenTree(t.roots, t.leafId, glyphs) : [];
	}

	/**
	 * Go back to an earlier point. On a prompt: the conversation continues from
	 * just before it, and the prompt comes back to edit. On a reply: from right
	 * after it. Like pi's own /tree, the old branch stays in the session file.
	 * pi's RPC has no command for this, so vigent stops pi, adds a marker entry
	 * under that point (pi continues from a file's last entry), and starts it again.
	 */
	async navigate(id: string): Promise<{ editorText?: string }> {
		if (this.state === "running" || this.state === "waiting") throw new Error(`'${this.name}' is running; wait for it or :pause it first`);
		await this.alive().catch(() => {});
		const file = this.sessionFile;
		const tree = file ? readSessionTree(file) : undefined;
		if (!file || !tree) throw new Error(`'${this.name}' keeps no conversation file to go back in`);
		const entry = findEntry(tree.roots, id);
		if (!entry) throw new Error("that point isn't in this conversation");
		const prompt = entry.type === "message" && entry.message?.role === "user";
		const parentId = prompt ? (entry.parentId ?? null) : entry.id;
		await this.stop();
		const marker = { type: "custom", customType: "vigent-branch", id: newEntryId(tree.roots), parentId, timestamp: new Date().toISOString(), data: {} };
		fs.appendFileSync(file, `${JSON.stringify(marker)}\n`);
		this.items = [];
		this.tokens = 0;
		this.cost = undefined;
		this.quietResume = true;
		await this.alive();
		this.emit();
		return { editorText: prompt ? extractText(entry.message.content) : undefined };
	}

	/** don't announce "resumed" for a restart vigent did itself */
	private quietResume = false;

	/** Stop pi and wait for it to go (no error: vigent asked). */
	private stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child || child.exitCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			child.once("exit", () => resolve());
			child.stdin?.end();
			child.kill("SIGTERM");
		});
	}

	dispose() {
		this.disposed = true;
		super.dispose();
		const child = this.child;
		this.child = undefined;
		if (child) {
			child.stdin?.end();
			child.kill("SIGTERM");
		}
	}
}

/** pi's session file as a tree (each entry points at its parent); the last entry is where it is now. */
export function readSessionTree(file: string): { roots: TreeNodeLike[]; leafId: string | null } | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const nodes = new Map<string, TreeNodeLike>();
	const labels = new Map<string, string>();
	const order: TreeNodeLike[] = [];
	let leafId: string | null = null;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!e?.id || e.type === "session") continue;
		if (e.type === "label") {
			if (e.label) labels.set(e.targetId, e.label);
			else labels.delete(e.targetId);
		}
		const node: TreeNodeLike = { entry: e, children: [] };
		nodes.set(e.id, node);
		order.push(node);
		leafId = e.id;
	}
	const roots: TreeNodeLike[] = [];
	for (const n of order) {
		const label = labels.get(n.entry.id);
		if (label) n.label = label;
		const parent = n.entry.parentId ? nodes.get(n.entry.parentId) : undefined;
		if (parent) parent.children.push(n);
		else roots.push(n);
	}
	return { roots, leafId };
}

/** The AGENTS.md (or CLAUDE.md) files pi reads: its own folder's, then each folder from / down to the agent's. */
export function contextFiles(cwd: string, agentDir: string): string[] {
	const pick = (dir: string) => ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
	const out: string[] = [];
	const global = pick(agentDir);
	if (global) out.push(global);
	const chain: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		const f = pick(dir);
		if (f && !out.includes(f)) chain.unshift(f);
		if (dir === path.dirname(dir)) break;
	}
	return [...out, ...chain];
}

function findEntry(nodes: TreeNodeLike[], id: string): TreeNodeLike["entry"] | undefined {
	for (const n of nodes) {
		if (n.entry.id === id) return n.entry;
		const found = findEntry(n.children, id);
		if (found) return found;
	}
	return undefined;
}

/** pi's ids: 8 hex characters, unique in the file */
function newEntryId(roots: TreeNodeLike[]): string {
	for (;;) {
		const id = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
		if (!findEntry(roots, id)) return id;
	}
}

function oneLine(s: unknown): string {
	return String(s ?? "").split("\n")[0].slice(0, 200);
}
