/**
 * pi extensions inside vigent.
 *
 * pi loads extensions (~/.pi/agent/extensions/, .pi/extensions/), skills and
 * prompt templates by itself. What it needs from the program around it is a
 * UI: an extension that asks before `rm -rf` calls ctx.ui.confirm(), a
 * command answers with ctx.ui.notify(). This is that UI, drawn the vigent way:
 * confirm is a y/n question, select and input are pickers, notify goes to the
 * transcript and the message line, setStatus shows in the winbar. The parts
 * that only make sense in pi's own TUI (custom editors, widgets, headers and
 * footers) do nothing here, as they do in pi's print mode.
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

/**
 * pi's ExtensionUIContext over a host that may come later: until vigent
 * attaches one (or in tests without a screen), dialogs answer like pi's print
 * mode: no selection, no confirmation, no input.
 */
export function extensionUi(host: () => PiUiHost | undefined, theme: () => unknown): Record<string, unknown> {
	const nothing = () => {};
	return {
		select: async (title: string, options: string[]) => host()?.select(title, options),
		confirm: async (title: string, message: string) => (await host()?.confirm(title, message)) ?? false,
		input: async (title: string, placeholder?: string) => host()?.input(title, placeholder),
		editor: async (title: string, prefill?: string) => host()?.input(title, prefill),
		notify: (message: string, type: "info" | "warning" | "error" = "info") => host()?.notify(String(message), type),
		setStatus: (key: string, text: string | undefined) => host()?.setStatus(key, text),
		onTerminalInput: () => nothing,
		setWorkingMessage: nothing,
		setWorkingVisible: nothing,
		setWorkingIndicator: nothing,
		setHiddenThinkingLabel: nothing,
		setWidget: nothing,
		setFooter: nothing,
		setHeader: nothing,
		setTitle: nothing,
		custom: async () => undefined,
		pasteToEditor: nothing,
		setEditorText: nothing,
		getEditorText: () => "",
		addAutocompleteProvider: nothing,
		setEditorComponent: nothing,
		getEditorComponent: () => undefined,
		get theme() {
			return theme();
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "vigent draws its own theme (:colorscheme)" }),
		getToolsExpanded: () => false,
		setToolsExpanded: nothing,
	};
}

/** What a pi agent has loaded, for `:pi`. */
export interface PiResources {
	extensions: { path: string; error?: string }[];
	commands: { name: string; description?: string }[];
	skills: { name: string; description?: string; path?: string }[];
	prompts: { name: string; description?: string }[];
	contextFiles: string[];
}

/** Read what pi loaded from a live AgentSession. Anything missing reads as empty. */
export function piResources(session: any): PiResources {
	const loader = session?.resourceLoader;
	const safe = <T,>(fn: () => T, fallback: T): T => {
		try {
			return fn() ?? fallback;
		} catch {
			return fallback;
		}
	};
	const ext = safe(() => loader.getExtensions(), { extensions: [], errors: [] });
	return {
		extensions: [
			...(ext.extensions ?? []).map((e: any) => ({ path: String(e.resolvedPath ?? e.path ?? "") })),
			...(ext.errors ?? []).map((e: any) => ({ path: String(e.path ?? ""), error: String(e.error ?? "failed to load") })),
		],
		commands: safe(() => session.extensionRunner.getRegisteredCommands(), []).map((c: any) => ({
			name: String(c.invocationName ?? c.name),
			description: c.description,
		})),
		skills: safe(() => loader.getSkills().skills, []).map((s: any) => ({ name: String(s.name), description: s.description, path: s.filePath })),
		prompts: safe(() => session.promptTemplates, []).map((p: any) => ({ name: String(p.name), description: p.description })),
		contextFiles: safe(() => loader.getAgentsFiles().agentsFiles, []).map((f: any) => String(f.path)),
	};
}
