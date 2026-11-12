/**
 * One git worktree per agent.
 *
 * `:new fix flaky checkout test` creates the branch `fix/flaky-checkout-test`
 * from the branch you're on, checks it out in its own worktree next to the
 * repo (../<repo>-worktrees/fix-flaky-checkout-test), and runs the agent
 * there. Agents never touch your checkout or each other's files.
 *
 * With riftri installed (https://riftri.dev, see riftri.ts) the worktree's
 * unchanged files share copy-on-write storage with the other agents', so a
 * new agent costs almost no disk. It's still a real git worktree.
 *
 * Removing is always the safe path: `git worktree remove` (or `riftri
 * worktree remove`) refuses when there are uncommitted changes, and
 * `git branch -d` keeps branches that aren't merged, unless you ask for --force.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { describeFailure, riftriAdd, riftriAddAsync, riftriBinary, riftriGc, riftriOwnership, riftriRemove, RIFTRI_INSTALL, type WorktreeBackend } from "./riftri.js";

const execFileAsync = promisify(execFile);

export interface DiffStat {
	files: number;
	added: number;
	removed: number;
}

export interface WorktreeInfo {
	branch: string;
	/** absolute path; absent for demo sessions */
	path?: string;
	/** the branch or commit the worktree was created from */
	base?: string;
	stat?: DiffStat;
	/** riftri's storage backend when riftri made it (reflink, apfs-clone, overlay-fs, ...) */
	riftri?: string;
	/** why riftri didn't make this one (backend "auto" fell back to git) */
	riftriSkipped?: string;
}

export interface WorktreeConfig {
	enabled: boolean;
	/** where worktrees go; relative paths are resolved from the repo root. {repo} = repo folder name */
	dir: string;
	/** branch name pattern: {type} (feat, fix, docs, ...) and {name} */
	branch: string;
	/** branch to start from; default: the branch currently checked out */
	base?: string;
	/** "auto": riftri when installed (copy-on-write), else git · "riftri": always · "git": never */
	backend: WorktreeBackend;
}

export const DEFAULT_WORKTREE: WorktreeConfig = {
	enabled: true,
	dir: "../{repo}-worktrees",
	branch: "{type}/{name}",
	backend: "auto",
};

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitOk(args: string[], cwd: string): boolean {
	try {
		git(args, cwd);
		return true;
	} catch {
		return false;
	}
}

/** Readable message from a failed git command. */
function gitError(err: unknown): string {
	const e = err as { stderr?: string | Buffer; message?: string };
	const text = (e.stderr ? String(e.stderr) : e.message ?? String(err)).trim();
	return text.replace(/^(fatal|error): /gm, "").split("\n")[0];
}

/** The repository's top-level folder, or undefined outside a git repo. */
export function repoRoot(cwd: string): string | undefined {
	try {
		return git(["rev-parse", "--show-toplevel"], cwd);
	} catch {
		return undefined;
	}
}

export function currentBranch(cwd: string): string {
	try {
		return git(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
	} catch {
		return git(["rev-parse", "--short", "HEAD"], cwd);
	}
}

// ---------------------------------------------------------------------------
// Branch names
// ---------------------------------------------------------------------------

/** Words that name the kind of change, mapped to the conventional branch type. */
const TYPES: Record<string, string> = {
	feat: "feat",
	feature: "feat",
	fix: "fix",
	bugfix: "fix",
	hotfix: "fix",
	bug: "fix",
	docs: "docs",
	doc: "docs",
	refactor: "refactor",
	test: "test",
	tests: "test",
	chore: "chore",
	perf: "perf",
	ci: "ci",
	build: "build",
	style: "style",
};

/** lowercase, ascii, hyphen-separated, at most `max` characters (cut on a word boundary). */
export function slugify(text: string, max = 48): string {
	const slug = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= max) return slug;
	const cut = slug.slice(0, max + 1);
	const boundary = cut.lastIndexOf("-");
	return (boundary > 8 ? cut.slice(0, boundary) : slug.slice(0, max)).replace(/-+$/, "");
}

/**
 * A conventional branch name for an agent:
 *   "fix flaky checkout test" -> fix/flaky-checkout-test
 *   "auth-refactor"           -> refactor/auth
 *   "docs: readme flags"      -> docs/readme-flags
 *   "add dark mode"           -> feat/add-dark-mode
 *   "release/v2-notes"        -> release/v2-notes   (a name with "/" is used as written)
 */
export function branchName(agentName: string, template = DEFAULT_WORKTREE.branch): string {
	if (agentName.includes("/")) {
		const parts = agentName.split("/").map((p) => slugify(p)).filter(Boolean);
		if (parts.length > 0) return parts.join("/");
	}
	const words = slugify(agentName, 200).split("-").filter(Boolean);
	let type = "feat";
	if (words.length > 1 && TYPES[words[0]]) {
		type = TYPES[words.shift() as string];
	} else if (words.length > 1 && TYPES[words[words.length - 1]]) {
		type = TYPES[words.pop() as string];
	}
	const name = slugify(words.join("-")) || "agent";
	return template.replace(/\{type\}/g, type).replace(/\{name\}/g, name);
}

function isValidBranch(name: string, cwd: string): boolean {
	return gitOk(["check-ref-format", "--branch", name], cwd);
}

function branchExists(name: string, cwd: string): boolean {
	return gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd);
}

export function worktreesDir(root: string, config: WorktreeConfig = DEFAULT_WORKTREE): string {
	const dir = config.dir.replace(/\{repo\}/g, path.basename(root));
	return path.resolve(root, dir);
}

// ---------------------------------------------------------------------------
// Create / remove / list
// ---------------------------------------------------------------------------

export function createWorktree(root: string, agentName: string, config: WorktreeConfig = DEFAULT_WORKTREE): WorktreeInfo {
	const info = planWorktree(root, agentName, config);
	try {
		const backend = config.backend ?? "auto";
		if (backend !== "git") {
			if (!riftriBinary()) {
				if (backend === "riftri") throw new Error(`[worktree] backend is "riftri", but riftri isn't installed: ${RIFTRI_INSTALL}`);
			} else {
				const r = riftriAdd(root, info.path!, info.branch, info.base!);
				if (r.ok) return { ...info, riftri: r.report?.backend ?? "riftri" };
				// riftri declined (unsupported volume, checkout or environment) and changed nothing: git is safe
				if (!r.declined || backend === "riftri") throw new Error(`riftri worktree add failed: ${describeFailure(r)}`);
				info.riftriSkipped = r.message;
			}
		}
		try {
			git(["worktree", "add", "-b", info.branch, info.path!, info.base!], root);
		} catch (err) {
			throw new Error(`git worktree add failed: ${gitError(err)}`);
		}
		return info;
	} finally {
		planned.delete(info.path!);
	}
}

/** Folders picked by planWorktree whose worktree isn't made yet, so two new agents never pick the same one. */
const planned = new Set<string>();
/** Worktrees being made, one at a time per repo: git and riftri both write the repo's own records. */
const making = new Map<string, Promise<unknown>>();

/**
 * Pick a new agent's branch and folder without making the worktree yet, so the
 * agent can show up at once; addWorktree makes it.
 */
export function planWorktree(root: string, agentName: string, config: WorktreeConfig = DEFAULT_WORKTREE): WorktreeInfo {
	const base = config.base || currentBranch(root);
	const wanted = branchName(agentName, config.branch);
	if (!isValidBranch(wanted, root)) throw new Error(`'${wanted}' is not a valid branch name (check [worktree] branch)`);

	const dir = worktreesDir(root, config);
	let branch = wanted;
	let folder = path.join(dir, wanted.replace(/\//g, "-"));
	for (let n = 2; planned.has(folder) || branchExists(branch, root) || fs.existsSync(folder); n++) {
		branch = `${wanted}-${n}`;
		folder = path.join(dir, branch.replace(/\//g, "-"));
	}

	fs.mkdirSync(dir, { recursive: true });
	excludeIfInside(root, dir);
	planned.add(folder);
	return { branch, path: folder, base, stat: { files: 0, added: 0, removed: 0 } };
}

/**
 * Make a planned worktree in the background: riftri when it can (copy-on-write),
 * else git. Resolves to the worktree with how it was made; rejects with why it
 * couldn't be, and then nothing was made.
 */
export function addWorktree(root: string, info: WorktreeInfo, config: WorktreeConfig = DEFAULT_WORKTREE): Promise<WorktreeInfo> {
	const folder = info.path!;
	const run = async (): Promise<WorktreeInfo> => {
		const backend = config.backend ?? "auto";
		const made: WorktreeInfo = { ...info };
		if (backend !== "git") {
			if (!riftriBinary()) {
				if (backend === "riftri") throw new Error(`[worktree] backend is "riftri", but riftri isn't installed: ${RIFTRI_INSTALL}`);
			} else {
				const r = await riftriAddAsync(root, folder, info.branch, info.base!);
				if (r.ok) return { ...made, riftri: r.report?.backend ?? "riftri" };
				if (!r.declined || backend === "riftri") throw new Error(`riftri worktree add failed: ${describeFailure(r)}`);
				made.riftriSkipped = r.message;
			}
		}
		try {
			await execFileAsync("git", ["worktree", "add", "-b", info.branch, folder, info.base!], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
		} catch (err) {
			throw new Error(`git worktree add failed: ${gitError(err)}`);
		}
		return made;
	};
	const turn = (making.get(root) ?? Promise.resolve()).then(run, run);
	const settled = turn.then(
		() => undefined,
		() => undefined,
	);
	making.set(root, settled);
	return turn.finally(() => {
		planned.delete(folder);
		if (making.get(root) === settled) making.delete(root);
	});
}

/** A worktrees folder inside the repo goes in .git/info/exclude (local, never committed) so `git status` stays clean. */
function excludeIfInside(root: string, dir: string) {
	const rel = path.relative(root, dir);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
	const file = path.resolve(root, git(["rev-parse", "--git-path", "info/exclude"], root));
	const entry = `/${rel.split(path.sep).join("/")}/`;
	const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (current.split("\n").includes(entry)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}

export interface RemoveResult {
	removed: boolean;
	branchDeleted: boolean;
	message: string;
}

/**
 * Remove a worktree, then delete its branch if it's merged. Without `force`,
 * git refuses to remove a worktree with uncommitted changes and keeps an
 * unmerged branch, so no work is lost by accident.
 */
export function removeWorktree(
	root: string,
	wt: { path: string; branch?: string; base?: string },
	force = false,
): RemoveResult {
	const dirtyMessage = `${wt.path} has uncommitted changes; use force to remove it anyway`;
	const owner = riftriOwnership(root, wt.path);
	if (owner.error) return { removed: false, branchDeleted: false, message: owner.error };
	if (owner.managed) {
		// riftri's removal is journaled; a forced one snapshots the view first
		const r = riftriRemove(root, wt.path, force);
		if (!r.ok) {
			const dirty = /has changes|uncommitted|dirty/i.test(r.message);
			return { removed: false, branchDeleted: false, message: dirty ? dirtyMessage : `removing the worktree failed: ${describeFailure(r)}` };
		}
		riftriGc(root); // free the shared base once no agent uses it
	} else {
		try {
			git(["worktree", "remove", ...(force ? ["--force"] : []), wt.path], root);
		} catch (err) {
			const reason = gitError(err);
			const dirty = /modified or untracked|contains modified/.test(reason);
			return { removed: false, branchDeleted: false, message: dirty ? dirtyMessage : reason };
		}
	}
	if (!wt.branch) return { removed: true, branchDeleted: false, message: `removed ${wt.path}` };
	try {
		const merged = force || isSquashMerged(root, wt.branch, wt.base);
		git(["branch", merged ? "-D" : "-d", wt.branch], root);
		return { removed: true, branchDeleted: true, message: `removed ${wt.path} and branch ${wt.branch}` };
	} catch {
		return {
			removed: true,
			branchDeleted: false,
			message: `removed ${wt.path}; kept branch ${wt.branch} (it has commits that aren't merged)`,
		};
	}
}

/**
 * A squash merge makes a new commit, so git doesn't see the branch as merged.
 * Treat it as merged when every file it changed has the same content on base.
 */
export function isSquashMerged(root: string, branch: string, base: string | undefined): boolean {
	if (!base) return false;
	try {
		const fork = git(["merge-base", base, branch], root);
		const files = git(["diff", "--name-only", fork, branch], root).split("\n").filter(Boolean);
		if (files.length === 0) return false;
		return gitOk(["diff", "--quiet", base, branch, "--", ...files], root);
	} catch {
		return false;
	}
}

export interface ListedWorktree {
	path: string;
	branch?: string;
	head: string;
}

/** Worktrees vigent manages (the ones inside the worktrees folder). */
export function listWorktrees(root: string, config: WorktreeConfig = DEFAULT_WORKTREE): ListedWorktree[] {
	const dir = worktreesDir(root, config);
	const out: ListedWorktree[] = [];
	let current: Partial<ListedWorktree> = {};
	const flush = () => {
		if (current.path && (current.path === dir || current.path.startsWith(dir + path.sep))) {
			out.push({ path: current.path, branch: current.branch, head: current.head ?? "" });
		}
		current = {};
	};
	for (const line of git(["worktree", "list", "--porcelain"], root).split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			current.path = line.slice(9);
		} else if (line.startsWith("HEAD ")) current.head = line.slice(5, 12);
		else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
	}
	flush();
	return out;
}

/** Find a managed worktree by branch, folder name, or path. */
export function findWorktree(root: string, query: string, config: WorktreeConfig = DEFAULT_WORKTREE): ListedWorktree | undefined {
	const all = listWorktrees(root, config);
	const abs = path.resolve(query);
	return (
		all.find((w) => w.branch === query) ??
		all.find((w) => path.basename(w.path) === query) ??
		all.find((w) => w.path === abs) ??
		all.find((w) => w.branch === branchName(query, config.branch))
	);
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

async function gitAsync(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch (err) {
		// `git diff --no-index` exits 1 when files differ; its stdout is still the diff
		const e = err as { code?: number; stdout?: string };
		if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
		throw err;
	}
}

/** The commit the worktree branched from, so later commits on the base don't show as changes. */
async function forkPoint(wt: WorktreeInfo): Promise<string> {
	if (!wt.path) throw new Error("no worktree");
	if (!wt.base) return "HEAD";
	try {
		return (await gitAsync(["merge-base", wt.base, "HEAD"], wt.path)).trim();
	} catch {
		return wt.base;
	}
}

async function untrackedFiles(cwd: string): Promise<string[]> {
	const out = await gitAsync(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
	return out.split("\0").filter(Boolean);
}

/** Everything the agent changed since the fork point: commits, uncommitted edits, and new files. */
export async function diffStat(wt: WorktreeInfo): Promise<DiffStat> {
	if (!wt.path) return wt.stat ?? { files: 0, added: 0, removed: 0 };
	const from = await forkPoint(wt);
	const stat: DiffStat = { files: 0, added: 0, removed: 0 };
	for (const line of (await gitAsync(["diff", "--numstat", from], wt.path)).split("\n")) {
		const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (!m) continue;
		stat.files++;
		stat.added += m[1] === "-" ? 0 : Number(m[1]);
		stat.removed += m[2] === "-" ? 0 : Number(m[2]);
	}
	for (const file of await untrackedFiles(wt.path)) {
		stat.files++;
		try {
			// read in the background, one file and one chunk at a time, so neither many new files nor one big one freezes the screen
			stat.added += await lineCount(fs.createReadStream(path.join(wt.path, file), { highWaterMark: 64 * 1024 }));
		} catch {
			// unreadable: count the file, not its lines
		}
	}
	return stat;
}

/**
 * Lines in a new file, as git diff counts them (a last line without a newline
 * counts too); 0 for a binary file. Counted chunk by chunk as the file is read.
 */
export async function lineCount(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): Promise<number> {
	let n = 0;
	let last = -1;
	for await (const buf of chunks) {
		if (buf.length === 0) continue;
		if (buf.includes(0)) return 0;
		for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) n++;
		last = buf[buf.length - 1];
	}
	return last === -1 || last === 10 ? n : n + 1;
}

/** Unified diff of everything the agent changed, new files included. */
export async function diffText(wt: WorktreeInfo, maxLines = 4000): Promise<string> {
	if (!wt.path) return "";
	const from = await forkPoint(wt);
	let text = await gitAsync(["diff", "--no-color", from], wt.path);
	for (const file of await untrackedFiles(wt.path)) {
		text += await gitAsync(["diff", "--no-color", "--no-index", "--", "/dev/null", file], wt.path);
	}
	const lines = text.split("\n");
	return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines` : text;
}
