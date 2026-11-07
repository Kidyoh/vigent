/**
 * What `:model` and `:effort` offer, per engine. Model lists come from the
 * engine itself where it can say (pi-ai's catalog, `opencode models`); any
 * name can still be typed in the picker.
 */
import { execFile } from "node:child_process";
import type { EngineId } from "./engines.js";

export interface Choice {
	value: string;
	note?: string;
}

/** Reasoning effort / thinking levels each engine accepts. */
export const EFFORTS: Record<EngineId, string[]> = {
	pi: ["off", "minimal", "low", "medium", "high", "xhigh"],
	claude: ["low", "medium", "high", "xhigh", "max"],
	codex: ["minimal", "low", "medium", "high", "xhigh"],
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
			return [{ value: "default", note: "Codex's own choice (type any model name)" }];
		case "opencode":
			return [{ value: "default", note: "OpenCode's own choice" }, ...(await opencodeModels(env)).map((value) => ({ value }))];
		case "pi": {
			const ai: any = await import("@mariozechner/pi-ai");
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
