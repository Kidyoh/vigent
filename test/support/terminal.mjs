/**
 * Drive the real `vigent` command in a pseudo-terminal, like a person would:
 * type keys, then read what's on the screen (rendered by xterm's headless
 * emulator, so the text is exactly what a terminal would show).
 */
import { execFileSync, spawn } from "node:child_process";
import * as path from "node:path";
import { createRequire } from "node:module";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless");
const PTY = path.join(import.meta.dirname, "ptyrun.py");
// found on the test runner's PATH: the terminal's own PATH may be minimal on purpose
const PYTHON = (() => {
	try {
		return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
	} catch {
		return "python3";
	}
})();
export const CLI = path.join(import.meta.dirname, "..", "..", "dist", "cli.js");
/** VIGENT_TTY_BINARY=<binary> runs every pty test against a standalone binary instead of Node and dist/. */
const DEFAULT_COMMAND = process.env.VIGENT_TTY_BINARY ? [path.resolve(process.env.VIGENT_TTY_BINARY)] : [process.execPath, CLI];

export class Tty {
	/** `command` is what runs vigent: Node and the built CLI, or a standalone binary. */
	constructor(args, { cwd, env, cols = 120, rows = 32, command = DEFAULT_COMMAND } = {}) {
		this.term = new Terminal({ cols, rows, allowProposedApi: true });
		this.output = "";
		this.child = spawn(PYTHON, ["-I", PTY, String(cols), String(rows), "--", ...command, ...args], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (d) => {
			this.output += d.toString("utf8");
			this.term.write(d);
		});
		this.stderr = "";
		this.child.stderr.on("data", (d) => (this.stderr += d));
		this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
	}

	/** The screen as text, one string per row. */
	lines() {
		const b = this.term.buffer.active;
		const out = [];
		for (let i = 0; i < this.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
		return out;
	}

	screen() {
		return this.lines().join("\n");
	}

	/** Wait until the screen shows `pattern` (a string or RegExp). */
	async waitFor(pattern, timeout = 15000) {
		const test = (s) => (typeof pattern === "string" ? s.includes(pattern) : pattern.test(s));
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, 50));
			await new Promise((r) => this.term.write("", r)); // let the emulator catch up
			if (test(this.screen())) return this.screen();
		}
		throw new Error(`timed out waiting for ${pattern}\n--- screen ---\n${this.screen()}\n--- stderr ---\n${this.stderr}`);
	}

	/** Type text or keys ("\r" Enter, "\x1b" Esc). Esc is sent on its own so it isn't read as Alt+key. */
	async type(text) {
		for (const part of text.split(/(\x1b)/)) {
			if (!part) continue;
			this.child.stdin.write(part);
			await new Promise((r) => setTimeout(r, part === "\x1b" ? 120 : 30));
		}
	}

	/** An ex command: ":" + text + Enter. */
	async ex(command) {
		await this.type(`:${command}\r`);
	}

	kill() {
		this.child.kill("SIGKILL");
	}
}
