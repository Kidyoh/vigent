/**
 * Telling you an agent is done while you look elsewhere: the terminal bell,
 * and a desktop notification in terminals that show one for OSC 9 (iTerm2,
 * WezTerm, Ghostty, kitty). Inside tmux the notification is passed through
 * to the outer terminal.
 */

export type NotifyMode = "auto" | "bell" | "desktop" | "off";
export const NOTIFY_MODES: NotifyMode[] = ["auto", "bell", "desktop", "off"];

/** Does this terminal turn OSC 9 into a desktop notification? */
export function showsDesktopNotifications(env: NodeJS.ProcessEnv = process.env): boolean {
	const program = env.TERM_PROGRAM ?? "";
	return (
		["iTerm.app", "WezTerm", "ghostty"].includes(program) ||
		Boolean(env.KITTY_WINDOW_ID) ||
		Boolean(env.GHOSTTY_RESOURCES_DIR) ||
		Boolean(env.WEZTERM_PANE) ||
		/kitty|ghostty/.test(env.TERM ?? "")
	);
}

/** The bytes to write for a notification: a bell, an OSC 9 notification, both, or nothing. */
export function alertSequence(text: string, mode: NotifyMode, env: NodeJS.ProcessEnv = process.env): string {
	if (mode === "off") return "";
	const desktop = mode === "desktop" || (mode === "auto" && showsDesktopNotifications(env));
	let out = mode === "desktop" ? "" : "\x07";
	if (desktop) {
		// no control characters inside the notification text
		const osc = `\x1b]9;${text.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`;
		// tmux swallows OSC 9 unless it's wrapped in a passthrough
		out += env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc;
	}
	return out;
}

/** Ask the terminal to report focus changes (\x1b[I / \x1b[O), so a visible agent doesn't notify. */
export const FOCUS_REPORTING_ON = "\x1b[?1004h";
export const FOCUS_REPORTING_OFF = "\x1b[?1004l";
