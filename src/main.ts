#!/usr/bin/env node
/**
 * The `vigent` command. Before anything else loads, it turns on Node's
 * compile cache (Node 22.1 and later): the compiled code of vigent and its
 * packages is kept on disk, so later starts skip compiling it again. That
 * matters most for the pi engine's SDK, which is large. Set
 * NODE_DISABLE_COMPILE_CACHE=1 to turn it off.
 */
import module from "node:module";

try {
	module.enableCompileCache?.();
} catch {
	// no cache: a read-only temp folder, say. Starting matters more.
}

await import("./cli.js");
