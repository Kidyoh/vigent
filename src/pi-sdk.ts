/**
 * The pi engine's packages, loaded only when a pi agent needs them.
 *
 * They're the bulk of an install (about 200 MB with every model provider's
 * SDK), and optional: the light install (`npm install --prefix ~/.vigent
 * --omit=optional @vigent/cli`) leaves them out for people who only run Claude
 * Code, Codex or OpenCode. Then pi shows as not installed, and nothing else
 * changes. (npm ignores --omit=optional with -g, hence the folder.)
 */

export const PI_PACKAGE = "@mariozechner/pi-coding-agent";
export const PI_INSTALL = "install vigent again without --omit=optional to add it";

/** Whether the pi engine is installed next to vigent (found the way an import would find it). */
export function piInstalled(resolve: (specifier: string) => string = (s) => import.meta.resolve(s)): boolean {
	try {
		resolve(PI_PACKAGE);
		resolve("@mariozechner/pi-ai");
		return true;
	} catch {
		return false;
	}
}

function missing(err: unknown): boolean {
	const code = (err as { code?: string })?.code;
	return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

const NOT_INSTALLED = `pi isn't installed (this is vigent's light install): ${PI_INSTALL}`;

/** pi's agent SDK. */
export async function loadPiSdk(): Promise<typeof import("@mariozechner/pi-coding-agent")> {
	try {
		return await import("@mariozechner/pi-coding-agent");
	} catch (err) {
		throw missing(err) ? new Error(NOT_INSTALLED) : err;
	}
}

/** pi's model catalog and providers. */
export async function loadPiAi(): Promise<typeof import("@mariozechner/pi-ai")> {
	try {
		return await import("@mariozechner/pi-ai");
	} catch (err) {
		throw missing(err) ? new Error(NOT_INSTALLED) : err;
	}
}
