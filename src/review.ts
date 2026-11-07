/**
 * Getting an agent's work out of its worktree: `:merge` and `:pr`.
 *
 * Both first commit whatever the agent left uncommitted, with a conventional
 * message built from the branch (fix/flaky-checkout-test -> "fix: flaky
 * checkout test").
 *
 * :merge squash-merges the branch into the base branch in your checkout (one
 * commit, like GitHub's squash merge). It refuses unless your checkout is on
 * that base branch with no uncommitted changes, and a conflict is rolled back
 * so your checkout is left exactly as it was.
 *
 * :pr pushes the branch and opens a pull request with `gh`, or prints the
 * compare URL when gh isn't available.
 */
import { execFileSync, spawnSync } from "node:child_process";
import type { WorktreeInfo } from "./worktree.js";

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitError(err: unknown): string {
	const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
	const text = String(e.stderr || e.stdout || e.message || err).trim();
	return text.replace(/^(fatal|error): /gm, "").split("\n")[0];
}

/** "fix/flaky-checkout-test" -> "fix: flaky checkout test"; "agent/add-search" -> "add search". */
export function commitMessage(branch: string): string {
	const parts = branch.split("/");
	const name = (parts.pop() ?? branch).replace(/-\d+$/, "").replace(/-/g, " ");
	const type = parts.pop();
	const conventional = ["feat", "fix", "docs", "refactor", "test", "chore", "perf", "ci", "build", "style"];
	return type && conventional.includes(type) ? `${type}: ${name}` : name;
}

/** Commit everything the agent left uncommitted. Returns the new commit, or undefined if there was nothing. */
export function commitPending(wt: WorktreeInfo, message = commitMessage(wt.branch)): string | undefined {
	if (!wt.path) throw new Error("no worktree");
	if (git(["status", "--porcelain"], wt.path) === "") return undefined;
	git(["add", "-A"], wt.path);
	try {
		git(["commit", "-q", "-m", message], wt.path);
	} catch (err) {
		throw new Error(`commit failed: ${gitError(err)}`);
	}
	return git(["rev-parse", "--short", "HEAD"], wt.path);
}

export interface MergeResult {
	ok: boolean;
	message: string;
	commit?: string;
}

/**
 * Squash-merge (default) or merge the agent's branch into its base branch,
 * in your checkout at `root`.
 */
export function mergeWorktree(root: string, wt: WorktreeInfo, opts: { squash?: boolean } = {}): MergeResult {
	const squash = opts.squash ?? true;
	if (!wt.path) return { ok: false, message: "this agent has no worktree" };
	const base = wt.base;
	if (!base) return { ok: false, message: "unknown base branch for this worktree" };

	const current = git(["branch", "--show-current"], root);
	if (current !== base) {
		return { ok: false, message: `your checkout is on '${current || "a detached HEAD"}'; switch it to '${base}' to merge` };
	}
	if (git(["status", "--porcelain", "--untracked-files=no"], root) !== "") {
		return { ok: false, message: `your checkout has uncommitted changes; commit or stash them, then :merge again` };
	}

	let pending: string | undefined;
	try {
		pending = commitPending(wt);
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}
	if (git(["rev-list", "--count", `${base}..${wt.branch}`], root) === "0") {
		return { ok: false, message: `nothing to merge: ${wt.branch} has no changes on top of ${base}` };
	}

	const message = commitMessage(wt.branch);
	if (squash) {
		try {
			git(["merge", "--squash", wt.branch], root);
		} catch (err) {
			const reason = gitError(err);
			git(["reset", "-q", "--merge"], root); // undo the half-applied squash
			return { ok: false, message: `merge conflict, nothing changed: ${reason}` };
		}
		if (git(["diff", "--cached", "--name-only"], root) === "") {
			git(["reset", "-q", "--merge"], root);
			return { ok: false, message: `nothing to merge: ${wt.branch} is already in ${base}` };
		}
		const log = git(["log", "--reverse", "--format=- %s", `${base}..${wt.branch}`], root);
		git(["commit", "-q", "-m", message, "-m", log], root);
	} else {
		try {
			git(["merge", "--no-ff", "-q", "-m", `Merge branch '${wt.branch}'`, wt.branch], root);
		} catch (err) {
			const reason = gitError(err);
			try {
				git(["merge", "--abort"], root);
			} catch {
				// nothing to abort
			}
			return { ok: false, message: `merge conflict, nothing changed: ${reason}` };
		}
	}
	const commit = git(["rev-parse", "--short", "HEAD"], root);
	const how = squash ? "squash-merged" : "merged";
	return {
		ok: true,
		commit,
		message: `${how} ${wt.branch} into ${base} as ${commit}${pending ? " (committed the agent's pending changes first)" : ""}`,
	};
}

/** https://github.com/owner/repo from an https or ssh remote URL, or undefined for other hosts. */
export function githubWebUrl(remote: string): string | undefined {
	const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
	return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

export interface PrResult {
	ok: boolean;
	message: string;
	url?: string;
}

/** Push the agent's branch and open a pull request (with gh when it's available). */
export function openPullRequest(root: string, wt: WorktreeInfo, opts: { remote?: string; useGh?: boolean } = {}): PrResult {
	const remote = opts.remote ?? "origin";
	if (!wt.path) return { ok: false, message: "this agent has no worktree" };
	let remoteUrl: string;
	try {
		remoteUrl = git(["remote", "get-url", remote], root);
	} catch {
		return { ok: false, message: `no '${remote}' remote to push to` };
	}
	try {
		commitPending(wt);
	} catch (err) {
		return { ok: false, message: (err as Error).message };
	}
	try {
		git(["push", "-q", "-u", remote, wt.branch], wt.path);
	} catch (err) {
		return { ok: false, message: `git push failed: ${gitError(err)}` };
	}

	const base = wt.base ?? "main";
	if (opts.useGh !== false) {
		const gh = spawnSync(
			"gh",
			["pr", "create", "--base", base, "--head", wt.branch, "--title", commitMessage(wt.branch), "--fill"],
			{ cwd: wt.path, encoding: "utf8", timeout: 60_000 },
		);
		const url = /https:\/\/\S+\/pull\/\d+/.exec(`${gh.stdout ?? ""}\n${gh.stderr ?? ""}`)?.[0];
		if (url) return { ok: true, url, message: `pull request: ${url}` };
	}
	const web = githubWebUrl(remoteUrl);
	if (web) {
		const url = `${web}/compare/${base}...${wt.branch}?expand=1`;
		return { ok: true, url, message: `pushed ${wt.branch}; open the pull request at ${url}` };
	}
	return { ok: true, message: `pushed ${wt.branch} to ${remote}` };
}
