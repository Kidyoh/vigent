/**
 * Agents survive a restart.
 *
 * Each agent's name, model, engine and pi conversation (or the id of its
 * Claude Code / Codex / OpenCode conversation) are saved inside git's own
 * record of its worktree (.git/worktrees/<name>/vigent/), not in your files.
 * When vigent starts it reopens every agent whose worktree is still there.
 * Removing the worktree (git worktree remove, :kill!) deletes this record
 * with it, so nothing is left behind.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EngineId } from "./engines.js";
import { listWorktrees, type WorktreeConfig, type WorktreeInfo } from "./worktree.js";

export interface AgentMeta {
	name: string;
	model: string;
	base?: string;
	createdAt: string;
	/** stopped with :kill: kept on disk, not reopened at startup (:attach brings it back) */
	detached?: boolean;
	/** what runs the agent; missing = pi */
	engine?: EngineId;
	/** a CLI engine's conversation id, to continue it */
	resumeId?: string;
	/** the model asked for (CLI engines; missing = the CLI's own default) */
	requestedModel?: string;
	/** reasoning effort / thinking level (missing = the engine's default) */
	effort?: string;
}

/** vigent's folder in git's per-worktree admin dir. */
export function agentStateDir(worktreePath: string): string {
	const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
		cwd: worktreePath,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	return path.join(gitDir, "vigent");
}

/** Where pi keeps this agent's conversation. */
export function sessionDir(worktreePath: string): string {
	return path.join(agentStateDir(worktreePath), "sessions");
}

export function saveAgentMeta(worktreePath: string, meta: AgentMeta) {
	const dir = agentStateDir(worktreePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "agent.json"), `${JSON.stringify(meta, null, "\t")}\n`);
}

export function loadAgentMeta(worktreePath: string): AgentMeta | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(agentStateDir(worktreePath), "agent.json"), "utf8"));
		return typeof raw?.name === "string" && typeof raw?.model === "string" ? (raw as AgentMeta) : undefined;
	} catch {
		return undefined;
	}
}

/** Mark an agent stopped (:kill) or running again (:attach). */
export function setDetached(worktreePath: string, detached: boolean) {
	const meta = loadAgentMeta(worktreePath);
	if (!meta) return;
	if (detached) meta.detached = true;
	else delete meta.detached;
	saveAgentMeta(worktreePath, meta);
}

export interface RestorableAgent {
	meta: AgentMeta;
	worktree: WorktreeInfo;
}

/** Agents to reopen at startup: vigent worktrees that have a saved, non-detached agent. */
export function restorableAgents(root: string, config: WorktreeConfig): RestorableAgent[] {
	const out: RestorableAgent[] = [];
	for (const w of listWorktrees(root, config)) {
		if (!w.branch || !fs.existsSync(w.path)) continue;
		const meta = loadAgentMeta(w.path);
		if (!meta || meta.detached) continue;
		out.push({ meta, worktree: { branch: w.branch, path: w.path, base: meta.base } });
	}
	return out.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
}

export interface ReopenResult {
	agents: (RestorableAgent & { backend?: string })[];
	/** riftri views that can't be used yet, with riftri's reason */
	blocked: { path: string; reason: string }[];
}

/**
 * Agents to reopen at startup, with riftri's views made ready first.
 *
 * An OverlayFS view loses its mount when the machine restarts: its folder is
 * then empty, so the agent's record (kept through the worktree's .git) can't
 * be read until riftri has repaired it. So every vigent worktree is inspected
 * (and repaired) before any record is read.
 */
export function reopenableAgents(
	root: string,
	config: WorktreeConfig,
	prepare: (root: string, paths: string[]) => Map<string, { ready: boolean; backend?: string; reason?: string }>,
): ReopenResult {
	const listed = listWorktrees(root, config).filter((w) => w.branch);
	const views = prepare(root, listed.map((w) => w.path));
	const blocked: ReopenResult["blocked"] = [];
	const agents: ReopenResult["agents"] = [];
	for (const w of listed) {
		const view = views.get(w.path);
		if (view && !view.ready) {
			blocked.push({ path: w.path, reason: view.reason ?? "not ready" });
			continue;
		}
		if (!fs.existsSync(w.path)) continue;
		const meta = loadAgentMeta(w.path);
		if (!meta || meta.detached) continue;
		agents.push({ meta, worktree: { branch: w.branch!, path: w.path, base: meta.base }, backend: view?.backend });
	}
	agents.sort((a, b) => a.meta.createdAt.localeCompare(b.meta.createdAt));
	return { agents, blocked };
}
