/**
 * Lightweight agent worktrees with riftri (https://riftri.dev).
 *
 * riftri creates real git linked worktrees whose unchanged files share
 * copy-on-write storage (APFS clones, Btrfs/XFS reflinks, ReFS block clones,
 * or OverlayFS), so ten agents on one repo cost about one checkout of disk.
 * vigent drives riftri's CLI through its machine-readable contract: one JSON
 * report on stdout with --json, one JSON receipt on stderr with --json-errors.
 *
 * With `[worktree] backend = "auto"` (the default) vigent uses riftri when it's
 * installed and falls back to plain `git worktree` only when riftri declines
 * with a policy receipt that says nothing was changed. Every other failure is
 * reported, never papered over.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { onPath } from "./engines.js";

export type WorktreeBackend = "auto" | "riftri" | "git";
export const WORKTREE_BACKENDS: WorktreeBackend[] = ["auto", "riftri", "git"];

export const RIFTRI_INSTALL = "npm install -g riftri  (or: curl -fsSL https://riftri.dev/install.sh | bash)";

/** riftri's failure receipt (stderr with --json-errors). */
export interface RiftriReceipt {
	code?: string;
	category?: string;
	cleanup?: string;
	message?: string;
	nextCommand?: string | null;
	operation?: string;
	phase?: string | null;
	recovery?: string;
	stateDirectory?: string | null;
}

export type RiftriResult<T = any> =
	| { ok: true; report: T }
	| {
			ok: false;
			exitCode: number;
			receipt?: RiftriReceipt;
			message: string;
			/** riftri declined and changed nothing: falling back to git is safe */
			declined: boolean;
	  };

let cachedBinary: { key: string; bin: string | undefined } | undefined;

/**
 * The riftri executable: $RIFTRI_BINARY, the `riftri` npm package (installed
 * with vigent), or `riftri` on PATH. Undefined when there's none.
 */
export function riftriBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const key = `${env.RIFTRI_BINARY ?? ""}\0${env.PATH ?? ""}`;
	if (cachedBinary?.key === key) return cachedBinary.bin;
	let bin: string | undefined;
	if (env.RIFTRI_BINARY) bin = fs.existsSync(env.RIFTRI_BINARY) ? env.RIFTRI_BINARY : undefined;
	else {
		try {
			// the package resolves and verifies the native binary for this platform
			const pkg = createRequire(import.meta.url)("riftri") as { resolveBinary(): string };
			bin = pkg.resolveBinary();
		} catch {
			bin = onPath("riftri", env) ? "riftri" : undefined;
		}
	}
	cachedBinary = { key, bin };
	return bin;
}

function parseReceipt(stderr: string): RiftriReceipt | undefined {
	const lines = stderr.trim().split("\n").reverse();
	for (const line of lines) {
		if (!line.trim().startsWith("{")) continue;
		try {
			return JSON.parse(line) as RiftriReceipt;
		} catch {
			// not the receipt
		}
	}
	return undefined;
}

function failure(err: any): RiftriResult & { ok: false } {
	const exitCode = typeof err?.status === "number" ? err.status : typeof err?.code === "number" ? err.code : 1;
	const stderr = String(err?.stderr ?? "");
	const receipt = parseReceipt(stderr);
	const message =
		receipt?.message ??
		(err?.code === "ENOENT" ? "riftri isn't installed" : stderr.trim().split("\n").pop() || err?.message || `exited with code ${exitCode}`);
	// only a policy receipt that confirms no cleanup is needed makes falling back safe
	const declined = exitCode === 3 && receipt?.category === "policy" && receipt.cleanup === "not-needed" && receipt.code !== "storage-full";
	return { ok: false, exitCode, receipt, message, declined };
}

function parseReport(stdout: string): any {
	const text = stdout.trim();
	return text ? JSON.parse(text) : null;
}

/** Run riftri and parse its report or receipt. Never throws. */
export function riftriSync<T = any>(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, bin = riftriBinary(env)): RiftriResult<T> {
	if (!bin) return { ok: false, exitCode: 127, message: "riftri isn't installed", declined: false };
	try {
		const out = execFileSync(bin, ["--json-errors", ...args], {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
			timeout: 10 * 60 * 1000,
		});
		return { ok: true, report: parseReport(out) };
	} catch (err) {
		return failure(err);
	}
}

/** The same, without blocking the UI (doctor and status walk the disk). */
export function riftriAsync<T = any>(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, bin = riftriBinary(env)): Promise<RiftriResult<T>> {
	if (!bin) return Promise.resolve({ ok: false, exitCode: 127, message: "riftri isn't installed", declined: false });
	return new Promise((resolve) => {
		execFile(bin, ["--json-errors", ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60 * 1000 }, (err, stdout, stderr) => {
			if (err) return resolve(failure({ ...err, status: (err as any).code, stderr }));
			try {
				resolve({ ok: true, report: parseReport(String(stdout)) });
			} catch (e) {
				resolve({ ok: false, exitCode: 1, message: `riftri printed something that isn't JSON: ${(e as Error).message}`, declined: false });
			}
		});
	});
}

/** A failed riftri step as one line, with the command riftri suggests. */
export function describeFailure(r: RiftriResult & { ok: false }): string {
	const next = r.receipt?.nextCommand;
	return `${r.message}${next ? ` (riftri suggests: ${next})` : ""}`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface RiftriAddReport {
	backend: string;
	base_path: string;
	reused_base: boolean;
	destination: string;
}

/** `riftri worktree add <folder> -b <branch> <base>` */
export function riftriAdd(root: string, folder: string, branch: string, base: string, env?: NodeJS.ProcessEnv): RiftriResult<RiftriAddReport> {
	return riftriSync(["worktree", "add", folder, "-b", branch, base, "--json", "--no-progress"], root, env);
}

/** The repository's riftri state folder (<common git dir>/riftri), if riftri has ever been used here. */
export function riftriStateDir(root: string): string | undefined {
	try {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const dir = path.join(common, "riftri");
		return fs.existsSync(dir) ? dir : undefined;
	} catch {
		return undefined;
	}
}

export interface Ownership {
	/** riftri manages this worktree */
	managed: boolean;
	backend?: string;
	/** riftri couldn't say for sure; don't touch the worktree with plain git */
	error?: string;
}

/**
 * Does riftri manage this worktree? Answered without running riftri when
 * the repository has no riftri state. An ownership error is not "unmanaged":
 * riftri's contract is to never turn it into ordinary git cleanup.
 */
export function riftriOwnership(root: string, worktreePath: string, env?: NodeJS.ProcessEnv): Ownership {
	if (!riftriStateDir(root)) return { managed: false };
	if (!riftriBinary(env)) {
		return { managed: false, error: `this repository has riftri worktrees, but riftri isn't installed: ${RIFTRI_INSTALL}` };
	}
	const r = riftriSync<{ worktrees: { path: string; state_directory: string | null; backend: string | null }[] }>(
		["worktree", "inspect", "--json", "--", worktreePath],
		root,
		env,
	);
	if (!r.ok) return { managed: false, error: describeFailure(r) };
	const w = r.report?.worktrees?.[0];
	return w?.state_directory ? { managed: true, backend: w.backend ?? undefined } : { managed: false };
}

/** `riftri worktree remove [--force]`; dirty views are refused unless forced. */
export function riftriRemove(root: string, worktreePath: string, force: boolean, env?: NodeJS.ProcessEnv): RiftriResult {
	return riftriSync(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath, "--json", "--no-progress"], root, env);
}

/** Reclaim bases no worktree uses any more (`riftri gc --apply`). Best effort. */
export function riftriGc(root: string, env?: NodeJS.ProcessEnv): RiftriResult<{ removed_allocated_bytes: number }> {
	return riftriSync(["gc", "--apply", "--json", "--no-progress"], root, env);
}

export interface ViewReadiness {
	path: string;
	ready: boolean;
	backend?: string;
	/** why it can't be used yet */
	reason?: string;
}

const READY_MOUNT = new Set([null, undefined, "active"]);

/**
 * Before reopening agents: inspect their worktrees, repair views whose
 * OverlayFS mount went away (a reboot), and inspect again. A repair that
 * succeeds is not proof by itself; only the second inspection is.
 */
export function prepareViews(root: string, paths: string[], env?: NodeJS.ProcessEnv): Map<string, ViewReadiness> {
	const out = new Map<string, ViewReadiness>();
	for (const p of paths) out.set(p, { path: p, ready: true });
	if (paths.length === 0 || !riftriStateDir(root) || !riftriBinary(env)) return out;
	const inspect = () =>
		riftriSync<{ worktrees: { path: string; backend: string | null; mount_status: string | null; state_directory: string | null }[] }>(
			["worktree", "inspect", "--json", "--", ...paths],
			root,
			env,
		);
	let r = inspect();
	if (!r.ok) {
		for (const p of paths) out.set(p, { path: p, ready: false, reason: describeFailure(r) });
		return out;
	}
	const needsRepair = new Set(
		r.report.worktrees.filter((w) => w.mount_status === "recovery-required" && w.state_directory).map((w) => w.state_directory as string),
	);
	if (needsRepair.size > 0) {
		for (const dir of needsRepair) riftriSync(["repair", "--state-dir", dir, "--json", "--no-progress"], root, env);
		r = inspect();
		if (!r.ok) {
			for (const p of paths) out.set(p, { path: p, ready: false, reason: describeFailure(r) });
			return out;
		}
	}
	r.report.worktrees.forEach((w, i) => {
		const p = paths[i] ?? w.path;
		const ready = READY_MOUNT.has(w.mount_status);
		out.set(p, {
			path: p,
			ready,
			backend: w.backend ?? undefined,
			reason: ready ? undefined : `riftri reports its mount as ${w.mount_status}; run: riftri repair --state-dir '${w.state_directory}'`,
		});
	});
	return out;
}

/** Which of these worktrees riftri manages, and with which backend (no disk walk). */
export function riftriBackends(root: string, paths: string[], env?: NodeJS.ProcessEnv): Map<string, string> {
	const out = new Map<string, string>();
	if (paths.length === 0 || !riftriStateDir(root) || !riftriBinary(env)) return out;
	const r = riftriSync<{ worktrees: { backend: string | null; state_directory: string | null }[] }>(["worktree", "inspect", "--json", "--", ...paths], root, env);
	if (!r.ok) return out;
	r.report.worktrees.forEach((w, i) => {
		if (w.state_directory && paths[i]) out.set(paths[i], w.backend ?? "riftri");
	});
	return out;
}

// ---------------------------------------------------------------------------
// Health and disk use (:checkhealth, :worktrees)
// ---------------------------------------------------------------------------

export interface RiftriHealth {
	installed: boolean;
	version?: string;
	/** riftri will make copy-on-write worktrees in the worktrees folder */
	ready: boolean;
	/** reflink, apfs-clone, refs-block-clone, overlay-fs, ... */
	backend?: string;
	detail: string;
	/** what's in the way, with riftri's remedy */
	blockers: string[];
	next?: string;
	/** managed worktrees and what they cost */
	views?: number;
	logicalBytes?: number;
	allocatedBytes?: number;
}

/** Ask riftri whether new agent worktrees in `dir` can be copy-on-write, and what the existing ones cost. */
export async function riftriHealth(root: string | undefined, dir: string | undefined, backend: WorktreeBackend, env: NodeJS.ProcessEnv = process.env): Promise<RiftriHealth> {
	const bin = riftriBinary(env);
	if (backend === "git") return { installed: Boolean(bin), ready: false, detail: "off ([worktree] backend = \"git\")", blockers: [] };
	if (!bin) return { installed: false, ready: false, detail: "not installed: agent worktrees are full copies", blockers: [] };
	const v = await new Promise<string | undefined>((resolve) =>
		execFile(bin, ["--version"], { env, timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : /\d+\.\d+\.\d+[\w.-]*/.exec(String(stdout))?.[0])),
	);
	if (!root || !dir) return { installed: true, version: v, ready: false, detail: "not in a git repository", blockers: [] };
	// doctor needs a destination that doesn't exist yet
	const probe = path.join(dir, `.vigent-probe-${process.pid}`);
	const doc = await riftriAsync<any>(["doctor", "--destination", probe, "--json"], root, env, bin);
	if (!doc.ok) return { installed: true, version: v, ready: false, detail: describeFailure(doc), blockers: [] };
	const rd = doc.report?.destination_readiness ?? {};
	// needs-activation only concerns riftri's git shim; vigent calls riftri directly
	const blockers: string[] = (rd.blockers ?? [])
		.filter((b: any) => b.kind !== "repository-activation")
		.map((b: any) => `${b.explanation}${b.remedy ? ` · ${b.remedy}` : ""}`);
	const ready = (rd.status === "ready" || rd.status === "needs-activation") && Boolean(rd.copy_on_write);
	const health: RiftriHealth = {
		installed: true,
		version: v,
		ready,
		backend: rd.backend ?? undefined,
		detail: ready ? `copy-on-write worktrees (${backendName(rd.backend)})` : blockers.length ? "can't optimize this repository yet" : `not available here (${rd.status ?? "blocked"})`,
		blockers,
		next: rd.status === "needs-activation" ? undefined : (rd.next_command ?? undefined),
	};
	if (riftriStateDir(root)) {
		const st = await riftriAsync<any>(["status", "--json"], root, env, bin);
		if (st.ok && st.report) {
			health.views = st.report.operations?.active_views ?? st.report.worktrees?.length ?? 0;
			health.logicalBytes = st.report.total_logical_bytes;
			health.allocatedBytes = st.report.total_allocated_bytes;
		}
	}
	return health;
}

export function backendName(backend: string | undefined | null): string {
	switch (backend) {
		case "reflink":
			return "Btrfs/XFS reflinks";
		case "apfs-clone":
		case "apfs":
			return "APFS clones";
		case "refs-block-clone":
		case "refs":
			return "ReFS block clones";
		case "overlay-fs":
			return "OverlayFS";
		default:
			return backend ?? "unknown";
	}
}

/** 16211491 -> "15.5 MB" */
export function formatBytes(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "?";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
