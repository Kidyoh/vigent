/**
 * `:serve`: follow your agents from your phone.
 *
 * A small HTTP server on your machine: a page that lists the agents and shows
 * a transcript as it streams, where you can send a prompt or stop an agent.
 * It starts only when you ask (`:serve`, or `vigent --serve`) and stops with
 * `:serve stop` or when vigent quits.
 *
 * Every API call needs the access code shown in vigent (8 characters, new
 * each time). Prompts and stops need it in a header, so another web page
 * can't send them from your browser. After 10 wrong codes the server stops
 * answering until you start it again. It's plain HTTP: use it on a network
 * you trust (home Wi-Fi, a VPN such as Tailscale), not on public Wi-Fi.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { ENGINE_NAMES } from "./engines.js";
import { servePage } from "./serve-page.js";
import type { Session, TranscriptItem } from "./session.js";
import type { Palette } from "./palette.js";

/** What the server needs from vigent (the App implements it; tests pass their own). */
export interface ServeHost {
	sessions(): Session[];
	/** the project's folder name, for the page title */
	project(): string;
	palette(): Palette;
	isUnread(s: Session): boolean;
	/** start an agent on a task (as `i` + a prompt does with no agent) */
	startAgent(task: string): Session | undefined;
	/** something worth a message line: a phone connected, a prompt arrived */
	notify(text: string): void;
}

export interface ServeOptions {
	port?: number;
	/** "0.0.0.0" (default: reachable from your phone) or "127.0.0.1" (this machine only) */
	host?: string;
	/** fixed access code (tests) */
	code?: string;
}

export interface ServeHandle {
	port: number;
	host: string;
	code: string;
	/** where to open it: this machine's network addresses first */
	urls: string[];
	/** phones (browsers) following right now */
	clients(): number;
	/** the agent list changed (added, removed) */
	sync(): void;
	close(): Promise<void>;
}

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i: easy to type on a phone
const MAX_FAILURES = 10;
const MAX_PROMPT = 20_000;

/** A fresh access code, like "k3x9-q2m7". */
export function newAccessCode(): string {
	const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

/** This machine's addresses a phone on the same network can reach (IPv4, not loopback). */
export function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
	}
	return out;
}

function same(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function agentSummary(s: Session, unread: boolean) {
	const st = s.worktree?.stat;
	const last = [...s.items].reverse().find((i) => i.kind === "agent" || i.kind === "user");
	return {
		id: s.id,
		name: s.name,
		engine: s.engine,
		engineName: ENGINE_NAMES[s.engine],
		model: s.model,
		effort: s.effort,
		state: s.state,
		branch: s.worktree?.branch,
		added: st?.added ?? 0,
		removed: st?.removed ?? 0,
		tokens: s.tokens,
		cost: s.cost,
		queued: s.queue.length,
		unread,
		version: s.version,
		last: last ? { kind: last.kind, text: preview(last.text) } : undefined,
	};
}

/** a reply as one plain line for the agent list: no markdown marks, no code fences */
function preview(text: string): string {
	return text
		.replace(/\x60\x60\x60[^\n]*\n?/g, " ")
		.replace(/\*\*|__|\x60/g, "")
		.replace(/^#+ /gm, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

function itemJson(i: TranscriptItem) {
	return {
		kind: i.kind,
		text: i.text.length > 50_000 ? `${i.text.slice(0, 50_000)}\n…` : i.text,
		streaming: i.streaming || undefined,
		tool: i.tool
			? { name: i.tool.name, summary: i.tool.summary, output: i.tool.output.length > 4000 ? `${i.tool.output.slice(0, 4000)}\n…` : i.tool.output }
			: undefined,
	};
}

export function startServer(host: ServeHost, opts: ServeOptions = {}): Promise<ServeHandle> {
	const code = opts.code ?? newAccessCode();
	const bind = opts.host ?? "0.0.0.0";
	let failures = 0;
	let locked = false;
	const streams = new Set<http.ServerResponse>();
	const watching = new Map<Session, () => void>();
	let pending: ReturnType<typeof setTimeout> | undefined;
	let everConnected = false;

	const broadcast = () => {
		if (pending) return;
		// coalesce: a streaming reply changes many times a second
		pending = setTimeout(() => {
			pending = undefined;
			const data = JSON.stringify({ agents: host.sessions().map((s) => agentSummary(s, host.isUnread(s))) });
			for (const res of streams) res.write(`event: agents\ndata: ${data}\n\n`);
		}, 120);
	};
	const sync = () => {
		const now = new Set(host.sessions());
		for (const [s, off] of watching) {
			if (!now.has(s)) {
				off();
				watching.delete(s);
			}
		}
		for (const s of now) if (!watching.has(s)) watching.set(s, s.onChange(broadcast));
		broadcast();
	};

	const authorized = (req: http.IncomingMessage, url: URL, headerOnly: boolean): boolean => {
		if (locked) return false;
		const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		const given = header ?? (headerOnly ? undefined : (url.searchParams.get("code") ?? undefined));
		if (given && same(given.trim().toLowerCase(), code)) return true;
		if (given !== undefined && ++failures >= MAX_FAILURES) {
			locked = true;
			host.notify(`:serve stopped answering after ${MAX_FAILURES} wrong access codes (:serve stop, then :serve, for a new one)`);
		}
		return false;
	};

	const send = (res: http.ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	};

	const readBody = (req: http.IncomingMessage): Promise<any> =>
		new Promise((resolve, reject) => {
			let size = 0;
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => {
				size += c.length;
				if (size > MAX_PROMPT * 4) {
					reject(new Error("too large"));
					req.destroy();
				} else chunks.push(c);
			});
			req.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
				} catch {
					reject(new Error("not JSON"));
				}
			});
			req.on("error", reject);
		});

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://vigent");
		const route = `${req.method} ${url.pathname}`;
		try {
			if (route === "GET /" || route === "GET /index.html") {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
					"referrer-policy": "no-referrer",
				});
				res.end(servePage(host.project(), host.palette()));
				return;
			}
			if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
			// reads may carry the code in the URL (EventSource can't set headers); changes need the header
			const writes = req.method !== "GET";
			if (!authorized(req, url, writes)) return send(res, locked ? 423 : 401, { error: locked ? "locked: start :serve again in vigent" : "wrong access code" });

			if (route === "GET /api/state") {
				return send(res, 200, { project: host.project(), agents: host.sessions().map((s) => agentSummary(s, host.isUnread(s))) });
			}
			if (route === "GET /api/events") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
				res.write(": vigent\n\n");
				streams.add(res);
				if (!everConnected) {
					everConnected = true;
					host.notify("a phone is following (:serve)");
				}
				const beat = setInterval(() => res.write(": beat\n\n"), 15_000);
				req.on("close", () => {
					clearInterval(beat);
					streams.delete(res);
				});
				broadcast();
				return;
			}
			if (route === "POST /api/agents") {
				const body = await readBody(req);
				const text = typeof body.text === "string" ? body.text.trim() : "";
				if (!text || text.length > MAX_PROMPT) return send(res, 400, { error: "a task, up to 20000 characters" });
				const s = host.startAgent(text);
				if (!s) return send(res, 409, { error: "couldn't start an agent (see vigent)" });
				s.submit(text);
				host.notify(`'${s.name}' started from your phone`);
				sync();
				return send(res, 200, { id: s.id });
			}
			const m = /^\/api\/agents\/(\d+)(\/prompt|\/stop)?$/.exec(url.pathname);
			const s = m ? host.sessions().find((x) => x.id === Number(m[1])) : undefined;
			if (!m || !s) return send(res, 404, { error: "no such agent" });
			if (req.method === "GET" && !m[2]) {
				return send(res, 200, { agent: agentSummary(s, host.isUnread(s)), items: s.items.map(itemJson) });
			}
			if (req.method === "POST" && m[2] === "/prompt") {
				const body = await readBody(req);
				const text = typeof body.text === "string" ? body.text.trim() : "";
				if (!text || text.length > MAX_PROMPT) return send(res, 400, { error: "a prompt, up to 20000 characters" });
				const waiting = s.submit(text);
				host.notify(`'${s.name}' got a prompt from your phone${waiting > 0 ? ` (queued, ${waiting} waiting)` : ""}`);
				return send(res, 200, { queued: waiting });
			}
			if (req.method === "POST" && m[2] === "/stop") {
				if (s.state === "running") s.abort();
				return send(res, 200, { state: s.state });
			}
			return send(res, 405, { error: "not allowed" });
		} catch (err) {
			if (!res.headersSent) send(res, 400, { error: String((err as Error).message ?? err) });
		}
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 8377, bind, () => {
			server.off("error", reject);
			const port = (server.address() as AddressInfo).port;
			const local = bind === "127.0.0.1" || bind === "localhost";
			const urls = [...(local ? [] : lanAddresses().map((a) => `http://${a}:${port}/`)), `http://127.0.0.1:${port}/`];
			sync();
			resolve({
				port,
				host: bind,
				code,
				urls,
				clients: () => streams.size,
				sync,
				close: () =>
					new Promise<void>((done) => {
						if (pending) clearTimeout(pending);
						for (const off of watching.values()) off();
						watching.clear();
						for (const r of streams) r.end();
						streams.clear();
						server.close(() => done());
						server.closeAllConnections?.();
					}),
			});
		});
	});
}
