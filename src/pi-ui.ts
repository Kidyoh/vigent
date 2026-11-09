/**
 * pi extensions inside vigent.
 *
 * pi loads extensions (~/.pi/agent/extensions/, .pi/extensions/), skills and
 * prompt templates by itself. What it needs from the program around it is a
 * UI: an extension that asks before `rm -rf` calls ctx.ui.confirm(), a
 * command answers with ctx.ui.notify(). In RPC mode those arrive as
 * extension_ui_request lines (pi-session.ts), and this is the UI vigent draws
 * for them: confirm is a y/n question, select and input are pickers, notify
 * goes to the transcript and the message line, setStatus shows in the winbar.
 * The parts that only make sense in pi's own TUI (widgets, headers, footers)
 * do nothing here.
 */

/** What vigent shows for an agent's extensions (the App implements it). */
export interface PiUiHost {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning" | "error"): void;
	/** a short status an extension keeps up to date; undefined clears it */
	setStatus(key: string, text: string | undefined): void;
}

/** What a pi agent has loaded, for `:pi`. */
export interface PiResources {
	extensions: { path: string; error?: string }[];
	commands: { name: string; description?: string }[];
	skills: { name: string; description?: string; path?: string }[];
	prompts: { name: string; description?: string }[];
	contextFiles: string[];
}
