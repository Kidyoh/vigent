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
import { PI_INSTALL, piInstalled } from "./pi-sdk.js";

export type EngineId = "pi" | "claude" | "codex" | "opencode";
export const ENGINE_IDS: EngineId[] = ["pi", "claude", "codex", "opencode"];

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
};

export const ENGINE_BINS: Record<Exclude<EngineId, "pi">, string> = {
	claude: "claude",
	codex: "codex",
	opencode: "opencode",
};

const INSTALL: Record<Exclude<EngineId, "pi">, string> = {
	claude: "npm install -g @anthropic-ai/claude-code",
	codex: "npm install -g @openai/codex",
	opencode: "npm install -g opencode-ai",
};

const PI_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY"];

export function isEngineId(s: string): s is EngineId {
	return (ENGINE_IDS as string[]).includes(s);
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

/** pi can run: an API key in the environment, or a saved pi login. */
export function piConnected(env: NodeJS.ProcessEnv = process.env): boolean {
	return detectPi(env).connected;
}

const CLI_IDS = ["claude", "codex", "opencode"] as const;

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

export function detectPi(env: NodeJS.ProcessEnv, installed = piInstalled()): EngineInfo {
	if (!installed) {
		return { id: "pi", name: ENGINE_NAMES.pi, installed: false, connected: false, detail: "not installed (light install)", install: PI_INSTALL };
	}
	const keys = PI_KEYS.filter((k) => env[k]);
	let stored = false;
	try {
		const auth = JSON.parse(fs.readFileSync(path.join(env.HOME ?? os.homedir(), ".pi", "agent", "auth.json"), "utf8"));
		stored = Object.keys(auth ?? {}).length > 0;
	} catch {
		// no pi login stored
	}
	const connected = keys.length > 0 || stored;
	return {
		id: "pi",
		name: ENGINE_NAMES.pi,
		installed: true,
		connected,
		detail: connected
			? `built in · ${keys.length > 0 ? `using ${keys.join(", ")}` : "using pi's saved login"}`
			: "built in · no API key found",
		connect: connected ? undefined : "export ANTHROPIC_API_KEY=… (or OPENAI_API_KEY, GEMINI_API_KEY)",
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

/**
 * What's known instantly, without running anything: which CLIs are on PATH,
 * and pi's keys. Shown at startup while detectEngines() asks the CLIs.
 */
export function quickEngines(env: NodeJS.ProcessEnv = process.env): EngineInfo[] {
	return [
		detectPi(env),
		...(["claude", "codex", "opencode"] as const).map((id): EngineInfo => {
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
	];
}

/** Check every engine in parallel. Each CLI check is bounded by `timeoutMs`. */
export async function detectEngines(env: NodeJS.ProcessEnv = process.env, timeoutMs = 8000): Promise<EngineInfo[]> {
	return Promise.all([
		Promise.resolve(detectPi(env)),
		detectClaude(env, timeoutMs),
		detectCodex(env, timeoutMs),
		detectOpenCode(env, timeoutMs),
	]);
}
