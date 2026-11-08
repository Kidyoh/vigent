/**
 * Session templates: a prompt you start agents with often, with the engine,
 * model and effort it should run on.
 *
 *   [templates.fix]
 *   prompt = "Find and fix this bug: {task}. Reproduce it with a failing test first."
 *   engine = "claude"
 *   effort = "high"
 *
 * `:new -t fix the cart total is off` starts an agent and sends the prompt,
 * with `{task}` replaced by what you typed. A few are built in; a template
 * in config.toml with the same name replaces the built-in one.
 */
import { EFFORTS } from "./choices.js";
import { type EngineId, isEngineId } from "./engines.js";

export interface Template {
	name: string;
	/** what the agent is told; `{task}` is replaced by the task you give */
	prompt: string;
	/** one line for the picker (default: the start of the prompt) */
	description?: string;
	engine?: EngineId;
	model?: string;
	effort?: string;
	/** false: run in your checkout instead of a new worktree */
	worktree?: boolean;
	builtin?: boolean;
}

export const BUILTIN_TEMPLATES: Template[] = [
	{
		name: "fix",
		description: "reproduce a bug with a failing test, then fix it",
		prompt:
			"Find and fix this bug: {task}\n\nFirst reproduce it with a failing test. Then make the smallest change that makes the test pass, and run the whole test suite before you finish.",
	},
	{
		name: "test",
		description: "write tests in the project's own style",
		prompt:
			"Write tests for {task}. Cover the usual cases and the edge cases, follow the style of the tests already in the project, and run them. Don't change the code under test; if a test finds a bug, say so.",
	},
	{
		name: "review",
		description: "review this branch's work; changes nothing",
		prompt:
			"Review the work on this branch: compare it with the branch it started from using git. Look for bugs, missing tests and code that's hard to follow.{task}\n\nList what you find by file and line, most serious first. Don't change any files.",
	},
	{
		name: "explain",
		description: "how something works and where it lives; changes nothing",
		prompt: "Explain {task}: how it works, where it lives in the code, and what would break if it changed. Don't change any files.",
	},
];

/** Whether the prompt has a place for the task. */
export function needsTask(t: Template): boolean {
	return t.prompt.includes("{task}");
}

/**
 * The prompt for a task. `{task}` takes the task; a template without one gets
 * the task added after it. The review template's `{task}` is optional focus.
 */
export function fillTemplate(t: Template, task: string): string {
	const text = task.trim();
	if (!needsTask(t)) return text ? `${t.prompt}\n\n${text}` : t.prompt;
	if (t.name === "review" && t.builtin) return t.prompt.replace("{task}", text ? ` Focus on: ${text}.` : "");
	return t.prompt.split("{task}").join(text);
}

/** Built-ins first, then yours (yours replace a built-in of the same name), in config order. */
export function allTemplates(user: Record<string, Template>): Template[] {
	const out = BUILTIN_TEMPLATES.map((t) => user[t.name] ?? { ...t, builtin: true });
	for (const t of Object.values(user)) if (!BUILTIN_TEMPLATES.some((b) => b.name === t.name)) out.push(t);
	return out;
}

/** `[templates]` from config.toml; problems become warnings, never errors. */
export function parseTemplates(value: unknown, warnings: string[]): Record<string, Template> {
	const out: Record<string, Template> = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push("config: [templates] should be a table");
		return out;
	}
	for (const [name, raw] of Object.entries(value)) {
		const where = `config [templates.${name}]`;
		if (!/^[\w-]+$/.test(name)) {
			warnings.push(`${where}: a template name is letters, digits, - and _`);
			continue;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			warnings.push(`${where} should be a table`);
			continue;
		}
		const r = raw as Record<string, unknown>;
		if (typeof r.prompt !== "string" || !r.prompt.trim()) {
			warnings.push(`${where}: 'prompt' is required`);
			continue;
		}
		const t: Template = { name, prompt: r.prompt.trim() };
		for (const [k, v] of Object.entries(r)) {
			switch (k) {
				case "prompt":
					break;
				case "description":
				case "model":
					if (typeof v === "string") t[k] = v;
					else warnings.push(`${where}: '${k}' should be a string`);
					break;
				case "engine":
					if (typeof v === "string" && isEngineId(v)) t.engine = v;
					else warnings.push(`${where}: 'engine' should be "pi", "claude", "codex" or "opencode"`);
					break;
				case "worktree":
					if (typeof v === "boolean") t.worktree = v;
					else warnings.push(`${where}: 'worktree' should be true or false`);
					break;
				case "effort":
					if (typeof v === "string") t.effort = v;
					else warnings.push(`${where}: 'effort' should be a string`);
					break;
				default:
					warnings.push(`${where}: unknown option '${k}'`);
			}
		}
		if (t.effort && t.engine && !(EFFORTS[t.engine] as string[]).includes(t.effort)) {
			warnings.push(`${where}: 'effort' should be one of ${EFFORTS[t.engine].join(", ")}`);
			delete t.effort;
		}
		out[name] = t;
	}
	return out;
}
