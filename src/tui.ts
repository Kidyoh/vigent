/**
 * The parts of pi-tui vigent uses: the TUI loop, key parsing, the terminal,
 * text width and fuzzy filtering. They're vendored (src/vendor/pi-tui, MIT,
 * unchanged) rather than installed, because the pi-tui package also brings
 * its editor, markdown and image components and, through koffi, native
 * builds for 18 platforms (28 MB) used only on Windows. Everything from
 * pi-tui goes through this file.
 */
import { ProcessTerminal as VendorProcessTerminal, type Terminal } from "./vendor/pi-tui/terminal.js";

export { fuzzyFilter } from "./vendor/pi-tui/fuzzy.js";
export { parseKey } from "./vendor/pi-tui/keys.js";
export { type Terminal } from "./vendor/pi-tui/terminal.js";
export { type Component, type OverlayOptions, TUI } from "./vendor/pi-tui/tui.js";
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./vendor/pi-tui/utils.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * ProcessTerminal with alternate screen buffer support (smcup / rmcup).
 *
 * Like Neovim / Vim, vigent runs in an alternate screen so that when it exits,
 * the terminal's previous screen content and scrollback are restored rather
 * than leaving vigent's full-screen UI persisting on the main screen.
 */
export class ProcessTerminal extends VendorProcessTerminal {
	private inAltScreen = false;
	private exitCleanup?: () => void;
	private sigCleanup?: () => void;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		if (!this.inAltScreen) {
			process.stdout.write(ENTER_ALT_SCREEN);
			this.inAltScreen = true;
		}
		super.start(onInput, onResize);

		if (!this.exitCleanup) {
			this.exitCleanup = () => this.restoreScreen();
			process.once("exit", this.exitCleanup);
		}

		if (!this.sigCleanup) {
			this.sigCleanup = () => {
				this.stop();
				process.exit(130);
			};
			process.once("SIGINT", this.sigCleanup);
			process.once("SIGTERM", this.sigCleanup);
			process.once("SIGHUP", this.sigCleanup);
		}
	}

	private restoreScreen(): void {
		if (this.inAltScreen) {
			process.stdout.write(EXIT_ALT_SCREEN + SHOW_CURSOR);
			this.inAltScreen = false;
		}
	}

	override stop(): void {
		super.stop();
		this.restoreScreen();

		if (this.exitCleanup) {
			process.removeListener("exit", this.exitCleanup);
			this.exitCleanup = undefined;
		}
		if (this.sigCleanup) {
			process.removeListener("SIGINT", this.sigCleanup);
			process.removeListener("SIGTERM", this.sigCleanup);
			process.removeListener("SIGHUP", this.sigCleanup);
			this.sigCleanup = undefined;
		}
	}
}
