/**
 * What `:model` and `:effort` offer, per engine. Model lists come from the
 * engine itself where it can say (pi-ai's catalog, `codex debug models`,
 * `opencode models`); any
 * name can still be typed in the picker.
 */
import { execFile } from "node:child_process";
import { ENGINE_BINS, type EngineId } from "./engines.js";
import { loadPiAi } from "./pi-sdk.js";

export interface Choice {
	value: string;
	note?: string;
}

/** Reasoning effort / thinking levels each engine accepts. */
export const EFFORTS: Record<EngineId, string[]> = {
	pi: ["off", "minimal", "low", "medium", "high", "xhigh"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	// what Codex's models take between them; each model's own levels come from `codex debug models`
	codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
	opencode: ["minimal", "low", "medium", "high", "max"],
};

export function effortChoices(engine: EngineId): Choice[] {
	return [{ value: "default", note: "what the engine uses" }, ...EFFORTS[engine].map((value) => ({ value }))];
}

/** pi providers whose key is in the environment (the ones pi can call now). */
const PI_KEYS: Record<string, string[]> = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	mistral: ["MISTRAL_API_KEY"],
	groq: ["GROQ_API_KEY"],
	xai: ["XAI_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	deepseek: ["DEEPSEEK_API_KEY"],
};

export async function modelChoices(engine: EngineId, env: NodeJS.ProcessEnv = process.env): Promise<Choice[]> {
	switch (engine) {
		case "claude":
			return [
				{ value: "default", note: "Claude Code's own choice" },
				{ value: "fable", note: "latest Fable" },
				{ value: "opus", note: "latest Opus" },
				{ value: "sonnet", note: "latest Sonnet" },
				{ value: "haiku", note: "latest Haiku" },
			];
		case "codex":
			return [
				{ value: "default", note: "Codex's own choice" },
				...(await codexModels(env)).map((m) => ({ value: m.slug, note: m.description ? `${m.name} · ${m.description}` : m.name })),
			];
		case "opencode":
			return [{ value: "default", note: "OpenCode's own choice" }, ...(await opencodeModels(env)).map((value) => ({ value }))];
		case "pi": {
			const ai: any = await loadPiAi().catch(() => undefined);
			if (!ai) return [{ value: "default", note: "pi isn't installed" }];
			const providers = Object.keys(PI_KEYS).filter((p) => PI_KEYS[p].some((k) => env[k]));
			const out: Choice[] = [];
			for (const provider of providers.length ? providers : ["anthropic"]) {
				let models: { id: string; name?: string }[] = [];
				try {
					models = ai.getModels(provider);
				} catch {
					continue;
				}
				for (const m of models) out.push({ value: provider === "anthropic" ? m.id : `${provider}/${m.id}`, note: m.name && m.name !== m.id ? m.name : undefined });
			}
			return out;
		}
	}
}

function opencodeModels(env: NodeJS.ProcessEnv): Promise<string[]> {
	return new Promise((resolve) => {
		execFile("opencode", ["models"], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			if (err) return resolve([]);
			resolve(
				String(stdout)
					.replace(/\x1b\[[0-9;]*m/g, "")
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l)),
			);
		});
	});
}

export interface CodexModel {
	slug: string;
	name: string;
	description?: string;
	/** the reasoning efforts this model takes */
	efforts: string[];
}

let codexCatalog: Promise<CodexModel[]> | undefined;

/**
 * The models your Codex offers, from `codex debug models` (its own catalog,
 * so it follows your Codex version and account). Asked once per run; empty
 * when Codex isn't installed or can't say.
 */
export function codexModels(env: NodeJS.ProcessEnv = process.env): Promise<CodexModel[]> {
	if (env !== process.env) return readCodexModels(env);
	codexCatalog ??= readCodexModels(env).then((list) => {
		if (!list.length) codexCatalog = undefined; // try again next time
		return list;
	});
	return codexCatalog;
}

function readCodexModels(env: NodeJS.ProcessEnv): Promise<CodexModel[]> {
	return new Promise((resolve) => {
		execFile(ENGINE_BINS.codex, ["debug", "models"], { env, timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err) return resolve([]);
			resolve(parseCodexModels(String(stdout)));
		});
	});
}

/** The models `codex debug models` lists for people to pick (not the hidden ones). */
export function parseCodexModels(json: string): CodexModel[] {
	try {
		const models: any[] = JSON.parse(json)?.models ?? [];
		return models
			.filter((m) => m && typeof m.slug === "string" && (m.visibility === undefined || m.visibility === "list"))
			.map((m) => ({
				slug: m.slug,
				name: typeof m.display_name === "string" ? m.display_name : m.slug,
				description: typeof m.description === "string" ? m.description : undefined,
				efforts: Array.isArray(m.supported_reasoning_levels)
					? m.supported_reasoning_levels.map((l: any) => (typeof l === "string" ? l : l?.effort)).filter((e: unknown) => typeof e === "string")
					: [],
			}));
	} catch {
		return [];
	}
}

/**
 * `:effort` for an agent: the levels its engine takes. For Codex, the levels
 * of the model it uses (all of Codex's levels when that's its default).
 */
export async function effortChoicesFor(engine: EngineId, model?: string, env: NodeJS.ProcessEnv = process.env): Promise<Choice[]> {
	if (engine !== "codex") return effortChoices(engine);
	const catalog = await codexModels(env);
	const own = catalog.find((m) => m.slug === model)?.efforts;
	const levels = own?.length ? own : [...new Set(catalog.flatMap((m) => m.efforts))];
	if (!levels.length) return effortChoices(engine);
	return [{ value: "default", note: "what the model uses" }, ...EFFORTS.codex.filter((e) => levels.includes(e)).map((value) => ({ value })), ...levels.filter((e) => !EFFORTS.codex.includes(e)).map((value) => ({ value }))];
}
