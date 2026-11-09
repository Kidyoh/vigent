/**
 * A stand-in model server for tests: speaks OpenAI's chat completions API
 * (streaming), so a real agent CLI configured with a custom provider pointing
 * here runs its whole loop (prompt → tool calls → tool results → reply)
 * without a network or an API key.
 *
 *   const model = await fakeOpenAI([
 *     { tool: "bash", args: { command: "echo hi" } },   // first request: call a tool
 *     { text: "Done: it printed hi." },                  // second request: reply
 *   ]);
 *   model.url   // http://127.0.0.1:PORT/v1
 *   model.requests  // what the agent sent
 *   await model.close();
 *
 * When the script runs out, every further request gets `fallback` (default: "ok").
 */
import * as http from "node:http";

export async function fakeOpenAI(script = [], { fallback = { text: "ok" } } = {}) {
	const requests = [];
	const queue = [...script];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", async () => {
			if (!req.url.endsWith("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let parsed = {};
			try {
				parsed = JSON.parse(body);
			} catch {}
			requests.push(parsed);
			const step = queue.length ? queue.shift() : fallback;
			if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
			if (step.status) {
				res.writeHead(step.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: step.error ?? "failed" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const chunk = (delta, finish = null, extra = {}) =>
				res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: parsed.model ?? "test", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
			chunk({ role: "assistant", content: "" });
			const tools = step.tools ?? (step.tool ? [{ name: step.tool, args: step.args ?? {} }] : []);
			if (step.text) {
				// a few pieces, so streaming shows
				const words = step.text.split(/(?<= )/);
				for (const w of words) chunk({ content: w });
			}
			tools.forEach((t, i) => {
				chunk({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name: t.name, arguments: "" } }] });
				chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(t.args) } }] });
			});
			const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
			chunk({}, tools.length ? "tool_calls" : "stop");
			res.write(`data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: parsed.model ?? "test", choices: [], usage })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		push: (...steps) => queue.push(...steps),
		close: () => new Promise((r) => server.close(r)),
	};
}

/** A pi config folder whose only provider is the fake server: model "fake/test". */
export function piAgentDir(fs, path, dir, url) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: url,
					api: "openai-completions",
					apiKey: "test",
					compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
					models: [{ id: "test", name: "Test Model", contextWindow: 100000, maxTokens: 4096 }],
				},
			},
		}),
	);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "test", quietStartup: true }));
	return dir;
}
