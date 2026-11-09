/**
 * The real pi (the devDependency's `pi` binary) for tests, talking to the
 * fake model server instead of a provider: no network, no key.
 *
 *   const pi = await realPi(tmp, [{ tool: "bash", args: { command: "ls" } }, { text: "done" }]);
 *   new PiSession("x", "default", { cwd, env: pi.env });
 *   pi.model.requests  // what pi sent to the model
 *   await pi.close();
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeOpenAI, piAgentDir } from "./fake-openai.mjs";

export const PI_BIN_DIR = path.join(import.meta.dirname, "..", "..", "node_modules", ".bin");

export async function realPi(tmp, script = [], opts = {}) {
	const model = await fakeOpenAI(script, opts);
	const agentDir = piAgentDir(fs, path, fs.mkdtempSync(path.join(tmp, "pi-agent-")), model.url);
	const env = {
		...process.env,
		PATH: `${PI_BIN_DIR}${path.delimiter}${process.env.PATH}`,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
	};
	// no real provider: keys, tokens and cloud credentials stay out
	for (const k of Object.keys(env)) if (/_API_KEY$|_TOKEN$|^AWS_|^AZURE_|^GOOGLE_|^GCLOUD|^VERTEX|^COPILOT/.test(k)) delete env[k];
	return { model, agentDir, env, close: () => model.close() };
}

/** Wait until `ok()` holds (or fail after `ms`). */
export async function until(ok, ms = 15000, what = "condition") {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}
