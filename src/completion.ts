/** Tab completion for the : command line. */

/** Every ex command, by the name you'd normally type (short forms still run, they just aren't offered). */
export const EX_COMMANDS = [
	"attach",
	"bNext",
	"bdelete",
	"bnext",
	"bprevious",
	"buffer",
	"buffers",
	"checkhealth",
	"close",
	"colorscheme",
	"cost",
	"dashboard",
	"diff",
	"effort",
	"engine",
	"engines",
	"extensions",
	"help",
	"highlight",
	"history",
	"jumps",
	"kill",
	"ls",
	"marks",
	"merge",
	"model",
	"new",
	"nohlsearch",
	"only",
	"options",
	"pause",
	"permissions",
	"pr",
	"qall",
	"queue",
	"quit",
	"resume",
	"review",
	"serve",
	"set",
	"settings",
	"split",
	"templates",
	"tree",
	"trust",
	"usage",
	"vsplit",
	"wincmd",
	"worktree",
	"worktrees",
	"wq",
	"write",
];

const WINCMD_KEYS = ["h", "j", "k", "l", "w", "W", "p", "t", "b", "v", "s", "c", "q", "o", "=", ">", "<", "+", "-", "|", "_", "x", "r"];
const AGENT_COMMANDS = new Set(["b", "buffer", "sp", "split", "vs", "vsp", "vsplit"]);
const THEME_COMMANDS = new Set(["colorscheme", "colo", "theme"]);

export interface CompletionSources {
	agents: string[];
	themes: string[];
}

/** The text before the part being completed, and what that part could be. */
export function completeCommandLine(line: string, sources: CompletionSources): { base: string; items: string[] } {
	const m = /^(\s*)(\S*)(\s+)?([\s\S]*)$/.exec(line) ?? ["", "", "", undefined, ""];
	const [, lead, cmd, gap, arg] = m;
	if (gap === undefined) return { base: lead, items: EX_COMMANDS.filter((c) => c.startsWith(cmd)) };
	const base = lead + cmd + gap;
	const options = AGENT_COMMANDS.has(cmd) ? sources.agents : THEME_COMMANDS.has(cmd) ? sources.themes : cmd === "wincmd" || cmd === "winc" ? WINCMD_KEYS : [];
	const needle = arg.toLowerCase();
	return { base, items: options.filter((o) => (AGENT_COMMANDS.has(cmd) ? o.toLowerCase().includes(needle) : o.toLowerCase().startsWith(needle))) };
}
