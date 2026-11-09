/**
 * Which agent engines are available, and are they signed in?
 *
 * pi runs inside vigent. Claude Code, Codex and OpenCode are the CLIs you
 * may already have installed; vigent runs them as they are, so each one uses
 * its own login (vigent never reads their credentials). Detection only runs
 * their version and login-status commands.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PI_BIN, PI_INSTALL } from "./pi-cli.js";

/** the engines vigent knows by itself */
export type BuiltinEngineId = "pi" | "claude" | "codex" | "opencode" | "gemini" | "cursor";
/** a built-in engine, or one defined in config ([engines.<id>] with a command) */
export type EngineId = BuiltinEngineId | (string & {});
export const ENGINE_IDS: BuiltinEngineId[] = ["pi", "claude", "codex", "opencode", "gemini", "cursor"];

/**
 * An agent CLI defined in config:
 *
 *   [engines.gemini]
 *   name = "Gemini CLI"
 *   command = ["gemini", "--yolo", "-p", "{prompt}"]
 *   output = "text"            # or "claude", "codex", "opencode": it prints their JSON
 *   model_args = ["-m", "{model}"]
 *   models = ["gemini-2.5-pro", "gemini-2.5-flash"]
 *   resume_args = ["--resume", "{id}"]   # with a JSON output: continue its conversation
 */
export interface CustomEngine {
	id: string;
	name: string;
	/** the program and its arguments; {prompt} is the prompt (added at the end without it), {model} the model */
	command: string[];
	/** how to read what it prints: plain text, or the JSON events of a CLI vigent knows */
	output: "text" | "claude" | "codex" | "opencode" | "gemini" | "cursor";
	/** added when a model is picked, e.g. ["-m", "{model}"] */
	modelArgs?: string[];
	/** offered by :model */
	models?: string[];
	/** with a JSON output: added to continue the conversation, e.g. ["--resume", "{id}"] */
	resumeArgs?: string[];
}

export const CUSTOM_ENGINES = new Map<string, CustomEngine>();

/** Make a custom engine known everywhere engines are listed (the sidebar, :engine, :checkhealth, --engine). */
export function registerCustomEngine(e: CustomEngine) {
	CUSTOM_ENGINES.set(e.id, e);
	ENGINE_NAMES[e.id] = e.name;
	ENGINE_BINS[e.id] = e.command[0];
	INSTALL[e.id] = `put ${e.command[0]} on your PATH`;
}

/** Every engine, built-in ones first. */
export function allEngineIds(): EngineId[] {
	return [...ENGINE_IDS, ...CUSTOM_ENGINES.keys()];
}

function customInfo(e: CustomEngine, env: NodeJS.ProcessEnv): EngineInfo {
	const installed = onPath(e.command[0], env);
	return {
		id: e.id,
		name: e.name,
		installed,
		connected: installed, // vigent can't know a custom CLI's login; it runs as you set it up
		detail: installed ? `from your config · runs ${e.command[0]}` : `${e.command[0]} isn't on PATH`,
		install: INSTALL[e.id],
	};
}

export interface EngineInfo {
	id: EngineId;
	name: string;
	installed: boolean;
	/** signed in / has credentials it can use */
	connected: boolean;
	version?: string;
	/** one line: how it's signed in, or why it isn't */
	detail: string;
	/** command to run to connect it */
	connect?: string;
	/** how to install it */
	install?: string;
	/** sign-in status not known yet (shown while the real check runs) */
	checking?: boolean;
	/** environment variables vigent leaves out when it runs this CLI, so the CLI uses its own login */
	dropEnv?: string[];
}

/** The environment to run an engine's CLI with: everything but what detection said to leave out. */
export function engineEnv(engine: EngineInfo | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (!engine?.dropEnv?.length) return env;
	const out = { ...env };
	for (const k of engine.dropEnv) delete out[k];
	return out;
}

export const ENGINE_NAMES: Record<EngineId, string> = {
	pi: "pi",
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	gemini: "Gemini CLI",
	cursor: "Cursor CLI",
};

export const ENGINE_BINS: Record<Exclude<EngineId, "pi">, string> = {
	claude: "claude",
	codex: "codex",
	opencode: "opencode",
	gemini: "gemini",
	cursor: "cursor-agent",
};

const INSTALL: Record<Exclude<EngineId, "pi">, string> = {
	claude: "npm install -g @anthropic-ai/claude-code",
	codex: "npm install -g @openai/codex",
	opencode: "npm install -g opencode-ai",
	gemini: "npm install -g @google/gemini-cli",
	cursor: "curl https://cursor.com/install -fsS | bash",
};

const PI_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"];

export function isEngineId(s: string): s is EngineId {
	return (ENGINE_IDS as string[]).includes(s) || CUSTOM_ENGINES.has(s);
}

/** Is this command on PATH? (a quick check, without running it) */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
				return true;
			} catch {
				// not here
			}
		}
	}
	return false;
}

/** pi can run: installed, with an API key in the environment, a saved pi login or providers of its own. */
export function piConnected(env: NodeJS.ProcessEnv = process.env): boolean {
	return detectPi(env).connected;
}

const CLI_IDS = ["claude", "codex", "opencode", "gemini", "cursor"] as const;

/**
 * The engine new agents use when none is given ("auto"): the first signed-in
 * CLI (Claude Code, Codex, OpenCode), so your own login and settings are used;
 * pi only when no CLI is ready and pi has a key. While the sign-in checks run,
 * an installed CLI still wins over pi. With nothing ready, the first installed
 * CLI, else pi (starting an agent then says how to connect one).
 */
export function defaultEngine(engines: EngineInfo[] | undefined, env: NodeJS.ProcessEnv = process.env): EngineId {
	if (engines) {
		const cli = (ok: (e: EngineInfo) => boolean) => CLI_IDS.map((id) => engines.find((e) => e.id === id)).find((e) => e && ok(e))?.id;
		const ready = cli((e) => e.connected) ?? cli((e) => e.installed && Boolean(e.checking));
		if (ready) return ready;
		if (engines.find((e) => e.id === "pi")?.connected) return "pi";
		return cli((e) => e.installed) ?? "pi";
	}
	for (const id of CLI_IDS) if (onPath(ENGINE_BINS[id], env)) return id;
	return "pi";
}

interface RunResult {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run a command with a timeout; never throws. */
function run(cmd: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code === "ENOENT" ? null : ((err as { code?: number }).code ?? 1)) : 0;
			resolve({ ok: !err, code: typeof code === "number" ? code : null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function firstVersion(s: string): string | undefined {
	return /\d+\.\d+\.\d+[\w.-]*/.exec(s)?.[0];
}

/** pi's config folder: $PI_CODING_AGENT_DIR, else ~/.pi/agent */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (dir) return dir.startsWith("~/") ? path.join(env.HOME ?? os.homedir(), dir.slice(2)) : dir;
	return path.join(env.HOME ?? os.homedir(), ".pi", "agent");
}

export function detectPi(env: NodeJS.ProcessEnv, installed = onPath(PI_BIN, env)): EngineInfo {
	if (!installed) {
		return { id: "pi", name: ENGINE_NAMES.pi, installed: false, connected: false, detail: "not installed", install: PI_INSTALL };
	}
	const keys = PI_KEYS.filter((k) => env[k]);
	const has = (file: string, ok: (v: any) => boolean) => {
		try {
			return ok(JSON.parse(fs.readFileSync(path.join(piAgentDir(env), file), "utf8")));
		} catch {
			return false;
		}
	};
	// a saved login (pi's /login), or providers of your own in models.json (Ollama, a proxy...)
	const stored = has("auth.json", (v) => Object.keys(v ?? {}).length > 0);
	const custom = has("models.json", (v) => Object.keys(v?.providers ?? {}).length > 0);
	const connected = keys.length > 0 || stored || custom;
	return {
		id: "pi",
		name: ENGINE_NAMES.pi,
		installed: true,
		connected,
		detail: connected
			? `using ${keys.length > 0 ? keys.join(", ") : stored ? "pi's saved login" : "your models.json providers"}`
			: "no API key found",
		connect: connected ? undefined : "export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY), or pi's /login",
		install: PI_INSTALL,
	};
}

async function detectClaude(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineInfo> {
	const base = { id: "claude" as const, name: ENGINE_NAMES.claude, install: INSTALL.claude, connect: "claude auth login" };
	const v = await run("claude", ["--version"], timeoutMs, env);
	if (v.code === null) return { ...base, installed: false, connected: false, detail: "not installed" };
	const version = firstVersion(v.stdout);
	const s = await run("claude", ["auth", "status", "--json"], timeoutMs, env);
	try {
		const st = JSON.parse(s.stdout);
		if (st.loggedIn) {
			const usesKey = st.authMethod === "api_key" || !!st.apiKeySource;
			// ANTHROPIC_API_KEY wins over a signed-in Claude account. When there is an account too,
			// leave the key out, so Claude Code runs on the login you use it with (an unscoped or
			// spent key otherwise fails every request, e.g. "not scoped to a workspace")
			if (usesKey && env.ANTHROPIC_API_KEY) {
				const without = { ...env };
				delete without.ANTHROPIC_API_KEY;
				const account = await run("claude", ["auth", "status", "--json"], timeoutMs, without);
				try {
					const a = JSON.parse(account.stdout);
					if (a.loggedIn && a.authMethod !== "api_key" && !a.apiKeySource) {
						return {
							...base,
							installed: true,
							connected: true,
							version,
							detail: "signed in (Claude account; ANTHROPIC_API_KEY left out)",
							connect: undefined,
							dropEnv: ["ANTHROPIC_API_KEY"],
						};
					}
				} catch {
					// no account to fall back to: the key it is
				}
			}
			return { ...base, installed: true, connected: true, version, detail: `signed in (${usesKey ? "API key" : "Claude account"})`, connect: undefined };
		}
		return { ...base, installed: true, connected: false, version, detail: "not signed in" };
	} catch {
		if (env.ANTHROPIC_API_KEY) return { ...base, installed: true, connected: true, version, detail: "using ANTHROPIC_API_KEY", connect: undefined };
		return { ...base, installed: true, connected: false, version, detail: "couldn't read sign-in status" };
	}
}

async function detectCodex(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineInfo> {
	const base = { id: "codex" as const, name: ENGINE_NAMES.codex, install: INSTALL.codex, connect: "codex login" };
	const v = await run("codex", ["--version"], timeoutMs, env);
	if (v.code === null) return { ...base, installed: false, connected: false, detail: "not installed" };
	const version = firstVersion(v.stdout);
	const s = await run("codex", ["login", "status"], timeoutMs, env);
	const text = strip(`${s.stdout}\n${s.stderr}`).trim();
	if (s.ok && /logged in/i.test(text) && !/not logged in/i.test(text)) {
		const line = text.split("\n").find((l) => /logged in/i.test(l)) ?? "signed in";
		return { ...base, installed: true, connected: true, version, detail: line.trim().replace(/^logged in/i, "signed in"), connect: undefined };
	}
	if (env.OPENAI_API_KEY) return { ...base, installed: true, connected: false, version, detail: "not signed in (OPENAI_API_KEY is set: printenv OPENAI_API_KEY | codex login --with-api-key)" };
	return { ...base, installed: true, connected: false, version, detail: "not signed in" };
}

async function detectOpenCode(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineInfo> {
	const base = { id: "opencode" as const, name: ENGINE_NAMES.opencode, install: INSTALL.opencode, connect: "opencode auth login" };
	const v = await run("opencode", ["--version"], timeoutMs, env);
	if (v.code === null) return { ...base, installed: false, connected: false, version: undefined, detail: "not installed" };
	const version = firstVersion(v.stdout);
	const s = await run("opencode", ["auth", "list"], timeoutMs, env);
	const text = strip(`${s.stdout}\n${s.stderr}`);
	const creds = Number(/(\d+)\s+credentials?/.exec(text)?.[1] ?? 0);
	const envVars = Number(/(\d+)\s+environment variables?/.exec(text)?.[1] ?? 0);
	if (creds > 0 || envVars > 0) {
		const parts = [creds > 0 ? `${creds} saved login${creds === 1 ? "" : "s"}` : "", envVars > 0 ? `${envVars} provider key${envVars === 1 ? "" : "s"} in the environment` : ""].filter(Boolean);
		return { ...base, installed: true, connected: true, version, detail: parts.join(", "), connect: undefined };
	}
	return { ...base, installed: true, connected: false, version, detail: "no providers connected" };
}

async function detectGemini(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineInfo> {
	const base = { id: "gemini" as const, name: ENGINE_NAMES.gemini, install: INSTALL.gemini, connect: "run gemini once and sign in (or export GEMINI_API_KEY)" };
	const v = await run("gemini", ["--version"], timeoutMs, env);
	if (v.code === null) return { ...base, installed: false, connected: false, detail: "not installed" };
	const version = firstVersion(v.stdout);
	const key = ["GEMINI_API_KEY", "GOOGLE_API_KEY"].find((k) => env[k]) ?? (env.GOOGLE_GENAI_USE_VERTEXAI ? "Vertex AI" : undefined);
	const home = env.HOME ?? os.homedir();
	// a Google sign-in leaves its credentials in ~/.gemini; vigent only checks the file is there
	const signedIn = fs.existsSync(path.join(home, ".gemini", "oauth_creds.json")) || fs.existsSync(path.join(home, ".gemini", "google_accounts.json"));
	if (key || signedIn) return { ...base, installed: true, connected: true, version, detail: key ? `using ${key}` : "signed in (Google account)", connect: undefined };
	return { ...base, installed: true, connected: false, version, detail: "not signed in" };
}

async function detectCursor(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<EngineInfo> {
	const base = { id: "cursor" as const, name: ENGINE_NAMES.cursor, install: INSTALL.cursor, connect: "cursor-agent login" };
	const v = await run("cursor-agent", ["--version"], timeoutMs, env);
	if (v.code === null) return { ...base, installed: false, connected: false, detail: "not installed" };
	const version = firstVersion(v.stdout);
	if (env.CURSOR_API_KEY) return { ...base, installed: true, connected: true, version, detail: "using CURSOR_API_KEY", connect: undefined };
	const s = await run("cursor-agent", ["status"], timeoutMs, env);
	const text = strip(`${s.stdout}\n${s.stderr}`);
	if (s.ok && /logged in|signed in|authenticated/i.test(text) && !/not (logged|signed) in|unauthenticated/i.test(text)) {
		const who = /(?:as|account:?)\s+(\S+@\S+)/i.exec(text)?.[1];
		return { ...base, installed: true, connected: true, version, detail: who ? `signed in as ${who}` : "signed in", connect: undefined };
	}
	return { ...base, installed: true, connected: false, version, detail: "not signed in" };
}

/**
 * What's known instantly, without running anything: which CLIs are on PATH,
 * and pi's keys. Shown at startup while detectEngines() asks the CLIs.
 */
export function quickEngines(env: NodeJS.ProcessEnv = process.env): EngineInfo[] {
	return [
		detectPi(env),
		...CLI_IDS.filter((id) => !CUSTOM_ENGINES.has(id)).map((id): EngineInfo => {
			const installed = onPath(ENGINE_BINS[id], env);
			return {
				id,
				name: ENGINE_NAMES[id],
				installed,
				connected: false,
				checking: installed,
				detail: installed ? "checking sign-in…" : "not installed",
				install: INSTALL[id],
			};
		}),
		...[...CUSTOM_ENGINES.values()].map((e) => customInfo(e, env)),
	];
}

/** Check every engine in parallel. Each CLI check is bounded by `timeoutMs`. */
export async function detectEngines(env: NodeJS.ProcessEnv = process.env, timeoutMs = 8000): Promise<EngineInfo[]> {
	return Promise.all([
		Promise.resolve(detectPi(env)),
		...(
			[
				["claude", detectClaude],
				["codex", detectCodex],
				["opencode", detectOpenCode],
				["gemini", detectGemini],
				["cursor", detectCursor],
			] as const
		)
			// a [engines.<id>] with a command replaces the built-in one
			.filter(([id]) => !CUSTOM_ENGINES.has(id))
			.map(([, detect]) => detect(env, timeoutMs)),
		...[...CUSTOM_ENGINES.values()].map((e) => Promise.resolve(customInfo(e, env))),
	]);
}
