/**
 * Hooks: shell commands vigent runs at points in an agent's life.
 *
 *   [hooks]
 *   worktree_created = "npm ci"      # in each new worktree, before the agent starts
 *   before_merge     = "npm test"    # before :merge and :pr; a failure stops them
 *   agent_finished   = "say done"    # whenever an agent stops (finished, failed, needs you)
 *
 * They run in the agent's worktree with a shell, and see VIGENT_HOOK,
 * VIGENT_AGENT, VIGENT_BRANCH, VIGENT_WORKTREE, VIGENT_REPO, VIGENT_ENGINE (and
 * VIGENT_STATE for agent_finished) in their environment.
 */
import { spawn } from "node:child_process";

export const HOOK_NAMES = ["worktree_created", "before_merge", "agent_finished"] as const;
export type HookName = (typeof HOOK_NAMES)[number];
export type Hooks = Partial<Record<HookName, string>>;

export interface HookResult {
	ok: boolean;
	/** exit code, or null when it was stopped (timeout) */
	code: number | null;
	/** the end of what it printed (stdout and stderr together) */
	output: string;
	ms: number;
	timedOut?: boolean;
}

/** How long each hook may run before it's stopped. */
export const HOOK_TIMEOUT_MS: Record<HookName, number> = {
	worktree_created: 15 * 60_000,
	before_merge: 15 * 60_000,
	agent_finished: 60_000,
};

const KEEP = 4000;

/** Run a hook's command in `cwd` with a shell. Never rejects: a failure is a result. */
export function runHook(command: string, opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number }): Promise<HookResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, { cwd: opts.cwd, shell: true, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ ok: false, code: null, output: String((err as Error).message ?? err), ms: 0 });
			return;
		}
		const keep = (d: Buffer) => {
			output += d.toString("utf8");
			if (output.length > KEEP * 2) output = output.slice(-KEEP);
		};
		child.stdout?.on("data", keep);
		child.stderr?.on("data", keep);
		const timer = opts.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, opts.timeoutMs)
			: undefined;
		timer?.unref?.();
		child.on("error", (err) => keep(Buffer.from(String(err.message))));
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ ok: code === 0 && !timedOut, code: timedOut ? null : code, output: output.slice(-KEEP).trimEnd(), ms: Date.now() - started, ...(timedOut ? { timedOut } : {}) });
		});
	});
}

/** "3.2s", "1m 05s" */
export function took(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The last non-empty line of a hook's output, for a one-line message. */
export function lastLine(output: string): string {
	return output.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}
