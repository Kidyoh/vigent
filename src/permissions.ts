/**
 * `:permissions`: what each agent may do without asking, toggled in place.
 *
 * Every engine keeps its permissions in its own arguments ([engines.<id>]
 * args) and, for Claude Code, its allow rules and ask. These helpers read and
 * change just the permission part of those arguments, keeping anything else
 * you put there.
 */

/** Claude Code's --permission-mode values. */
export const CLAUDE_MODES = ["acceptEdits", "default", "plan", "bypassPermissions"] as const;
/** Codex's sandbox_mode values. */
export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
/** Gemini CLI's --approval-mode values. */
export const GEMINI_APPROVALS = ["default", "auto_edit", "yolo"] as const;

/** Allow rules worth a single key in the panel: [rule, label]. */
export const CLAUDE_PRESETS: [rule: string, label: string][] = [
	["Bash(gh:*)", "GitHub CLI (gh)"],
	["Bash(git:*)", "git, any subcommand"],
	["Bash(npm:*)", "npm"],
	["WebFetch", "fetch web pages"],
	["WebSearch", "web search"],
];

/** The value after `flag` (`--permission-mode plan`), or undefined. */
export function flagValue(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	if (i >= 0 && i + 1 < args.length) return args[i + 1];
	const eq = args.find((a) => a.startsWith(`${flag}=`));
	return eq?.slice(flag.length + 1);
}

/** Set `flag value` (or remove the flag when value is undefined), keeping every other argument. */
export function withFlag(args: string[], flag: string, value: string | undefined): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag) {
			i++; // and its value
			continue;
		}
		if (args[i].startsWith(`${flag}=`)) continue;
		out.push(args[i]);
	}
	return value === undefined ? out : [...out, flag, value];
}

/** A bare switch (`--force`) on or off. */
export function withSwitch(args: string[], flag: string, on: boolean): string[] {
	const rest = args.filter((a) => a !== flag);
	return on ? [...rest, flag] : rest;
}

/** Codex's `-c key=value` overrides: the value for `key`, without TOML quotes. */
export function codexOption(args: string[], key: string): string | undefined {
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] !== "-c" && args[i] !== "--config") continue;
		const m = /^([^=]+)=(.*)$/.exec(args[i + 1]);
		if (m && m[1].trim() === key) return m[2].trim().replace(/^"(.*)"$/, "$1");
	}
	return undefined;
}

/** Set (or remove) one `-c key=value`; strings are written TOML-quoted, like Codex expects. */
export function withCodexOption(args: string[], key: string, value: string | boolean | undefined): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if ((args[i] === "-c" || args[i] === "--config") && i + 1 < args.length && /^([^=]+)=/.exec(args[i + 1])?.[1].trim() === key) {
			i++;
			continue;
		}
		out.push(args[i]);
	}
	if (value === undefined) return out;
	return [...out, "-c", `${key}=${typeof value === "boolean" ? value : JSON.stringify(value)}`];
}
