/**
 * Copy text to the system clipboard, like vim's "+ register.
 *
 * Always sends OSC 52 (the terminal sets the clipboard; works over SSH and in
 * tmux with set-clipboard on), and also pipes to a local clipboard tool when
 * one is installed.
 */
import { spawn, spawnSync } from "node:child_process";

const TOOLS: [string, string[]][] = [
	["pbcopy", []],
	["wl-copy", []],
	["xclip", ["-selection", "clipboard"]],
	["xsel", ["--clipboard", "--input"]],
	["clip.exe", []],
];

let cachedTool: [string, string[]] | null | undefined;

function localTool(): [string, string[]] | null {
	if (cachedTool !== undefined) return cachedTool;
	cachedTool = null;
	for (const [cmd, args] of TOOLS) {
		if (cmd === "wl-copy" && !process.env.WAYLAND_DISPLAY) continue;
		if ((cmd === "xclip" || cmd === "xsel") && !process.env.DISPLAY) continue;
		const which = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
		if (which.status === 0) {
			cachedTool = [cmd, args];
			break;
		}
	}
	return cachedTool;
}

/** The OSC 52 escape sequence that asks the terminal to set its clipboard. */
export function osc52(text: string): string {
	const seq = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
	// inside tmux, wrap it so tmux passes it on to the outer terminal
	return process.env.TMUX ? `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : seq;
}

/** Copy `text`. `write` sends raw bytes to the terminal. Returns how it was copied. */
export function copyToClipboard(text: string, write: (data: string) => void): string {
	write(osc52(text));
	const tool = localTool();
	if (tool) {
		try {
			const child = spawn(tool[0], tool[1], { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {});
			child.stdin.end(text);
			return tool[0];
		} catch {
			// fall back to OSC 52 only
		}
	}
	return "terminal";
}
