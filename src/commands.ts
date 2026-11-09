/**
 * Your own ex commands, like vim's :command:
 *
 *   [commands]
 *   Review = "new -t review {args}"     # an ex command (the ":" is optional)
 *   Land = ["pr", "kill"]               # several, one after another
 *   Test = "!npm test"                  # a shell command, in the agent's worktree
 *
 * Names start with a capital letter, as in vim, so they never shadow a built-in.
 * {args} (or vim's <args>) is what you type after the name.
 */

export type UserCommands = Record<string, string[]>;

export const COMMAND_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** One step of a command: ":new x" → "new x"; "!npm test" stays a shell command. */
export function normalizeStep(step: string): string {
	return step.trim().replace(/^:+\s*/, "");
}

/** Whether running it starts a program on your machine (a shell step): from a project file, that waits for :trust. */
export function runsShell(steps: string[]): boolean {
	return steps.some((s) => normalizeStep(s).startsWith("!"));
}

/** Fill in what was typed after the name. */
export function fillArgs(step: string, args: string): string {
	return step.split("{args}").join(args).split("<args>").join(args);
}

/** Parse [commands]. Mistakes are warnings; shell commands from an untrusted file are gated. */
export function parseCommands(
	value: unknown,
	where: string,
	warnings: string[],
	gated: string[],
	mayRun: boolean,
): UserCommands {
	const out: UserCommands = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${where}: [commands] should be a table, e.g. Test = "!npm test"`);
		return out;
	}
	for (const [name, v] of Object.entries(value)) {
		if (!COMMAND_NAME.test(name)) {
			warnings.push(`${where} [commands]: '${name}' should start with a capital letter (letters and digits), like vim's :command`);
			continue;
		}
		const steps = typeof v === "string" ? [v] : Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
		if (!steps || steps.some((s) => !normalizeStep(s))) {
			warnings.push(`${where} [commands]: '${name}' should be an ex command ("new -t review {args}"), a shell command ("!npm test") or a list of them`);
			continue;
		}
		if (!mayRun && runsShell(steps)) {
			gated.push(`commands.${name}`);
			continue;
		}
		out[name] = steps.map(normalizeStep);
	}
	return out;
}
