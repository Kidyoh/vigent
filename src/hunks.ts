/**
 * `:review`: keep or drop the agent's changes one hunk at a time.
 *
 * The diff is the agent's whole change, fork point → working tree (commits,
 * uncommitted edits and new files). Dropping a hunk reverse-applies just that
 * hunk to the worktree (`git apply -R`), so `:merge` / `:pr`, which commit
 * what's in the worktree, no longer carry it. Undo applies it again.
 */
import { execFile } from "node:child_process";

export interface Hunk {
	/** the `@@ -a,b +c,d @@` line */
	header: string;
	lines: string[];
}

export interface FileDiff {
	path: string;
	/** `diff --git` through `+++` */
	header: string[];
	hunks: Hunk[];
	binary: boolean;
}

/** Split `git diff` output into files and hunks. */
export function parseDiff(text: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | undefined;
	let hunk: Hunk | undefined;
	for (const line of text.replace(/\n$/, "").split("\n")) {
		if (line.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
			file = { path: m ? m[2] : line.slice(11), header: [line], hunks: [], binary: false };
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (!file) continue;
		if (line.startsWith("@@")) {
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (hunk) {
			// "… N more lines" from a truncated diff is not part of any hunk
			if (/^[ +\-\\]/.test(line) || line === "") hunk.lines.push(line);
			continue;
		}
		if (/^Binary files /.test(line) || line === "GIT binary patch") file.binary = true;
		file.header.push(line);
	}
	return files;
}

/** A patch with one file's header and just these of its hunks. */
export function patchFor(file: FileDiff, hunks: Hunk[] = file.hunks): string {
	// a new file's single hunk must create the whole file; a partial patch can't say "new file"
	return `${[...file.header, ...hunks.flatMap((h) => [h.header, ...h.lines])].join("\n")}\n`;
}

function gitApply(cwd: string, patch: string, reverse: boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["apply", ...(reverse ? ["-R"] : []), "--whitespace=nowarn", "--recount", "-"],
			{ cwd },
			(err, _stdout, stderr) => (err ? reject(new Error(String(stderr).trim().split("\n")[0].replace(/^error: /, "") || err.message)) : resolve()),
		);
		child.stdin?.end(patch);
	});
}

/** Take a change out of the agent's worktree. */
export function dropPatch(worktree: string, patch: string): Promise<void> {
	return gitApply(worktree, patch, true);
}

/** Put a dropped change back. */
export function restorePatch(worktree: string, patch: string): Promise<void> {
	return gitApply(worktree, patch, false);
}
