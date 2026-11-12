/**
 * The Bun build's own code (src/standalone.ts): finding the folder the binary
 * is in and running itself again. Only the optional Bun build uses it (the
 * binary that ships is the Rust one). test/standalone.test.mjs is the check
 * any build has to pass.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { bundledBinary, selfCommand, standaloneDir } from "../dist/standalone.js";

const windows = process.platform === "win32";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vigent-stand-in-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("beside the binary: its real folder through a symlink, and the programs shipped there", () => {
	const real = path.join(tmp, "opt");
	fs.mkdirSync(real);
	fs.writeFileSync(path.join(real, "vigent"), "");
	fs.writeFileSync(path.join(real, "riftri"), "");
	fs.mkdirSync(path.join(real, "folder"));
	assert.equal(standaloneDir(path.join(real, "vigent")), real);
	if (!windows) {
		fs.mkdirSync(path.join(tmp, "links"));
		fs.symlinkSync(path.join(real, "vigent"), path.join(tmp, "links", "vigent"));
		assert.equal(standaloneDir(path.join(tmp, "links", "vigent")), real, "a symlink on PATH leads to the folder with riftri in it");
	}
	assert.equal(standaloneDir(path.join(tmp, "gone", "vigent")), path.join(tmp, "gone"), "a path that doesn't resolve is used as it is");
	assert.equal(bundledBinary("riftri", real, "linux"), path.join(real, "riftri"));
	assert.equal(bundledBinary("riftri", real, "win32"), undefined, "riftri.exe on Windows");
	assert.equal(bundledBinary("folder", real, "linux"), undefined, "a folder isn't a program");
	assert.equal(bundledBinary("nope", real, "linux"), undefined);
});

test("running vigent again: the binary alone, or node with its script", () => {
	assert.deepEqual(selfCommand(["theme", "import"], true, "/opt/vigent/vigent", "/$bunfs/root/vigent"), { command: "/opt/vigent/vigent", args: ["theme", "import"] });
	assert.deepEqual(selfCommand(["theme", "import"], false, "/usr/bin/node", "/lib/vigent/dist/main.js"), { command: "/usr/bin/node", args: ["/lib/vigent/dist/main.js", "theme", "import"] });
});
