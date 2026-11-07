/** Scripted demo content so the UI can be explored without API keys. */
import { DemoSession } from "./session.js";
import { branchName } from "./worktree.js";

export function createDemoSessions(): DemoSession[] {
	const auth = new DemoSession("auth-refactor", "claude-sonnet-5-5", {
		branch: branchName("auth-refactor"),
		stat: { files: 2, added: 41, removed: 18 },
	});
	auth.pushUser("Refactor the session middleware to use the new token store.");
	auth.play([
		{ delay: 300, kind: "state", state: "running" },
		{
			delay: 400,
			kind: "agent",
			streamMs: 90,
			text: "I'll start by reading the current middleware to understand how sessions are validated today.",
		},
		{
			delay: 500,
			kind: "tool",
			tool: {
				name: "read",
				summary: "src/middleware/auth.ts",
				output: "import { verify } from '../lib/jwt';\n\nexport async function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token) return res.status(401).end();\n  // legacy: validates against the jwt secret directly\n  const claims = verify(token, process.env.JWT_SECRET);\n  req.user = claims.sub;\n  next();\n}",
			},
		},
		{
			delay: 900,
			kind: "tool",
			tool: {
				name: "edit",
				summary: "src/middleware/auth.ts (+41 −18)",
				output: "- const claims = verify(token, process.env.JWT_SECRET);\n- req.user = claims.sub;\n+ const session = await tokenStore.resolve(token);\n+ if (!session) return res.status(401).end();\n+ req.user = session.userId;",
			},
		},
		{
			delay: 800,
			kind: "tool",
			tool: { name: "bash", summary: "npm test -- auth", output: "PASS test/middleware/auth.test.ts\n  ✓ rejects missing token (3 ms)\n  ✓ resolves session from TokenStore (5 ms)\n  ✓ rejects revoked tokens (2 ms)\n\nTests: 14 passed, 14 total" },
		},
		{
			delay: 700,
			kind: "agent",
			streamMs: 80,
			text: [
				"Done. The middleware now resolves tokens through **TokenStore** instead of verifying JWTs inline:",
				"- revoked tokens are rejected with a `401`",
				"- all 14 tests pass",
				"```ts",
				"const session = await tokenStore.resolve(token);",
				"if (!session) return res.status(401).end();",
				"```",
				"Want me to update the docs too?",
			].join("\n"),
		},
		{ delay: 300, kind: "state", state: "waiting" },
	]);

	const flaky = new DemoSession("fix-flaky-test", "claude-haiku-5-5", {
		branch: branchName("fix-flaky-test"),
		stat: { files: 1, added: 6, removed: 2 },
	});
	flaky.pushUser("The checkout e2e test fails ~1 in 5 runs. Find the race and fix it.");
	flaky.play([
		{ delay: 1200, kind: "state", state: "running" },
		{ delay: 600, kind: "agent", streamMs: 110, text: "Reproducing first — running the suite 10 times to catch the failure." },
		{
			delay: 1500,
			kind: "tool",
			tool: { name: "bash", summary: "for i in $(seq 10); do npm run e2e -- checkout; done", output: "run 1..6: pass\nrun 7: FAIL expected cart badge '3', got '2'\nrun 8..10: pass" },
		},
		{ delay: 2500, kind: "agent", streamMs: 120, text: "Caught it: the badge assertion runs before the cart mutation settles. The test clicks 'add' and asserts immediately instead of awaiting the network idle. Fixing with a proper waitFor on the cart response." },
		{ delay: 200, kind: "state", state: "waiting" },
	]);

	const docs = new DemoSession("docs-pass", "claude-haiku-5-5");
	docs.pushUser("Sweep the README for stale CLI flags.");
	docs.play([
		{ delay: 500, kind: "agent", text: "Swept README.md and docs/cli.md: fixed 3 stale flags (--watch → --dev, removed --legacy-peer, documented --json). Committed as docs: refresh CLI flags." },
		{ delay: 100, kind: "state", state: "idle" },
	]);

	return [auth, flaky, docs];
}
