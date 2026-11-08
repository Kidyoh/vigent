/**
 * The page `:serve` shows on your phone: one self-contained HTML file in the
 * colors of the theme vigent is using. No external scripts, styles or fonts.
 */
import type { Palette } from "./palette.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function servePage(project: string, palette: Palette): string {
	const p = {
		...palette,
		bg_dark: palette.bg_dark ?? palette.bg,
		bg_alt: palette.bg_alt ?? palette.bg,
		selection: palette.selection ?? palette.blue,
		muted: palette.muted ?? palette.fg,
		subtle: palette.subtle ?? palette.fg,
		accent: palette.accent ?? palette.yellow,
	};
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${esc(p.bg_dark)}">
<title>vigent · ${esc(project)}</title>
<style>
:root {
	--bg: ${p.bg}; --bg-dark: ${p.bg_dark}; --bg-alt: ${p.bg_alt}; --sel: ${p.selection};
	--fg: ${p.fg}; --muted: ${p.muted}; --subtle: ${p.subtle}; --accent: ${p.accent};
	--blue: ${p.blue}; --green: ${p.green}; --yellow: ${p.yellow}; --red: ${p.red}; --cyan: ${p.cyan}; --magenta: ${p.magenta};
	--mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
	--sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); -webkit-text-size-adjust: 100%; }
button, textarea, input { font: inherit; color: inherit; }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); background: var(--bg-dark); border-bottom: 1px solid var(--sel); }
header h1 { margin: 0; font: 600 16px/1.2 var(--mono); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header .project { color: var(--muted); font-weight: 400; }
.back { border: 0; background: none; color: var(--blue); font-size: 22px; line-height: 1; padding: 4px 8px 4px 0; cursor: pointer; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--subtle); flex: none; }
.dot.live { background: var(--green); }
main { padding: 12px 16px 160px; max-width: 760px; margin: 0 auto; }
.empty, .note { color: var(--muted); text-align: center; padding: 40px 12px; }
.card { display: block; width: 100%; text-align: left; border: 1px solid var(--sel); background: var(--bg-dark); border-radius: 12px; padding: 12px 14px; margin: 0 0 10px; cursor: pointer; }
.card:active { background: var(--bg-alt); }
.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.name { font: 600 15px/1.3 var(--mono); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--muted); font: 12px/1.4 var(--mono); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.last { color: var(--fg); opacity: .85; font-size: 13px; margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.badge { font: 600 11px/1 var(--mono); padding: 4px 7px; border-radius: 999px; background: var(--bg-alt); color: var(--muted); flex: none; text-transform: lowercase; }
.badge.running { color: var(--bg); background: var(--green); }
.badge.waiting { color: var(--bg); background: var(--yellow); }
.badge.error { color: var(--bg); background: var(--red); }
.badge.paused { color: var(--bg); background: var(--subtle); }
.new { color: var(--yellow); font: 600 12px var(--mono); }
.add { color: var(--green); } .del { color: var(--red); }
.item { margin: 14px 0; }
.user { font: 600 14px/1.5 var(--mono); color: var(--accent); white-space: pre-wrap; word-break: break-word; }
.user::before { content: "❯ "; color: var(--blue); }
.agent { white-space: pre-wrap; word-break: break-word; }
.agent code { font: 13px var(--mono); background: var(--bg-alt); padding: 1px 5px; border-radius: 4px; color: var(--green); }
.agent pre, details pre { font: 12.5px/1.45 var(--mono); background: var(--bg-dark); border: 1px solid var(--sel); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre; margin: 8px 0; }
.agent pre code { background: none; padding: 0; color: var(--fg); }
.agent .h { font-weight: 700; color: var(--accent); }
.streaming::after { content: "▍"; color: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
details { font: 13px/1.4 var(--mono); }
summary { color: var(--muted); cursor: pointer; list-style: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸ "; } details[open] summary::before { content: "▾ "; }
summary b { color: var(--cyan); font-weight: 600; }
.info { color: var(--muted); font-size: 13px; font-style: italic; white-space: pre-wrap; }
.composer { position: fixed; left: 0; right: 0; bottom: 0; z-index: 3; background: var(--bg-dark); border-top: 1px solid var(--sel); padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
.composer .inner { max-width: 760px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; min-height: 44px; max-height: 40vh; resize: none; border: 1px solid var(--sel); background: var(--bg); border-radius: 12px; padding: 10px 12px; font: 15px/1.4 var(--sans); outline: none; }
textarea:focus, input:focus { border-color: var(--blue); }
.btn { border: 0; border-radius: 12px; padding: 0 16px; height: 44px; font-weight: 600; cursor: pointer; background: var(--blue); color: var(--bg); flex: none; }
.btn.stop { background: var(--red); }
.btn:disabled { opacity: .5; }
.login { max-width: 360px; margin: 18vh auto 0; padding: 0 20px; text-align: center; }
.login h2 { font: 700 26px var(--mono); margin: 0 0 6px; color: var(--accent); }
.login p { color: var(--muted); margin: 0 0 22px; }
.login input { width: 100%; text-align: center; letter-spacing: 3px; font: 600 22px var(--mono); padding: 12px; border-radius: 12px; border: 1px solid var(--sel); background: var(--bg-dark); outline: none; }
.login .btn { width: 100%; margin-top: 12px; }
.err { color: var(--red); min-height: 1.5em; margin-top: 10px; font-size: 14px; }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 96px; background: var(--bg-alt); border: 1px solid var(--sel); padding: 8px 14px; border-radius: 999px; font-size: 13px; z-index: 4; }
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
let code = store.get("vigent-code") || "";
if (location.hash.length > 1) { code = decodeURIComponent(location.hash.slice(1)); store.set("vigent-code", code); history.replaceState(null, "", location.pathname); }
const state = { agents: [], open: null, items: [], version: -1, live: false, project: ${JSON.stringify(project)}, sending: false };
const $app = document.getElementById("app");
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
const usd = (c) => c === undefined || c === null ? "" : " · $" + (c > 0 && c < 0.01 ? c.toFixed(3) : c.toFixed(2));

async function api(path, body) {
	const r = await fetch(path, { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + code, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
	if (r.status === 401 || r.status === 423) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || "wrong access code"), { auth: true }); }
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || r.statusText);
	return data;
}

function toast(text) {
	const t = document.createElement("div"); t.className = "toast"; t.textContent = text; document.body.appendChild(t);
	setTimeout(() => t.remove(), 2200);
}

function markdown(text) {
	return text.split(/(\\x60\\x60\\x60[^\\n]*\\n[\\s\\S]*?(?:\\x60\\x60\\x60|$))/).map((part) => {
		const fence = /^\\x60\\x60\\x60([^\\n]*)\\n([\\s\\S]*?)(?:\\x60\\x60\\x60)?$/.exec(part);
		if (fence) return "<pre><code>" + h(fence[2].replace(/\\n$/, "")) + "</code></pre>";
		return h(part)
			.replace(/^(#{1,4}) (.*)$/gm, (_m, _hashes, t) => '<span class="h">' + t + "</span>")
			.replace(/\\x60([^\\x60\\n]+)\\x60/g, "<code>$1</code>")
			.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
	}).join("");
}

function renderLogin(error) {
	$app.innerHTML = '<div class="login"><h2>vigent</h2><p>Type the access code vigent shows after <code>:serve</code>.</p>' +
		'<form id="f"><input id="c" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" placeholder="xxxx-xxxx" value="' + h(code) + '"><button class="btn">Follow</button></form>' +
		'<div class="err">' + h(error || "") + "</div></div>";
	document.getElementById("f").onsubmit = (e) => { e.preventDefault(); code = document.getElementById("c").value.trim().toLowerCase(); store.set("vigent-code", code); start(); };
}

function header(title, back) {
	return "<header>" + (back ? '<button class="back" id="back" aria-label="All agents">‹</button>' : "") +
		"<h1>" + title + '</h1><span class="dot' + (state.live ? " live" : "") + '" title="' + (state.live ? "live" : "reconnecting") + '"></span></header>';
}

function meta(a) {
	return h(a.engineName) + " · " + h(a.model || "default") + (a.effort ? " · " + h(a.effort) : "") +
		(a.branch ? " · ⎇ " + h(a.branch) : "") +
		(a.added || a.removed ? ' · <span class="add">+' + a.added + '</span> <span class="del">−' + a.removed + "</span>" : "") +
		(a.tokens ? " · " + tok(a.tokens) + " tok" + usd(a.cost) : "");
}

function composer(placeholder, running) {
	return '<div class="composer"><form class="inner" id="send"><textarea id="t" rows="1" placeholder="' + h(placeholder) + '"></textarea>' +
		(running ? '<button type="button" class="btn stop" id="stop">Stop</button>' : "") + '<button class="btn" id="go">Send</button></form></div>';
}

function wireComposer(onSend) {
	const t = document.getElementById("t");
	const grow = () => { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.4) + "px"; };
	t.oninput = grow;
	t.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); document.getElementById("send").requestSubmit(); } };
	document.getElementById("send").onsubmit = async (e) => {
		e.preventDefault();
		const text = t.value.trim();
		if (!text || state.sending) return;
		state.sending = true; document.getElementById("go").disabled = true;
		try { await onSend(text); t.value = ""; grow(); } catch (err) { toast(err.message); }
		state.sending = false; const go = document.getElementById("go"); if (go) go.disabled = false;
	};
	const stop = document.getElementById("stop");
	if (stop) stop.onclick = async () => { try { await api("/api/agents/" + state.open + "/stop", {}); toast("stopped"); } catch (err) { toast(err.message); } };
}

function renderList() {
	const draft = document.getElementById("t")?.value || "";
	const cards = state.agents.map((a) =>
		'<button class="card" data-id="' + a.id + '"><div class="row"><span class="name">' + h(a.name) + "</span>" +
		(a.unread ? '<span class="new">● new</span>' : "") + '<span class="badge ' + h(a.state) + '">' + h(a.state) + (a.queued ? " +" + a.queued : "") + "</span></div>" +
		'<div class="meta">' + meta(a) + "</div>" + (a.last ? '<div class="last">' + (a.last.kind === "user" ? "❯ " : "") + h(a.last.text) + "</div>" : "") + "</button>").join("");
	$app.innerHTML = header('vigent <span class="project">· ' + h(state.project) + "</span>") +
		"<main>" + (cards || '<div class="empty">No agents yet. Describe a task below to start one.</div>') + "</main>" + composer("New agent: describe a task", false);
	for (const c of document.querySelectorAll(".card")) c.onclick = () => openAgent(Number(c.dataset.id));
	document.getElementById("t").value = draft;
	wireComposer(async (text) => { const r = await api("/api/agents", { text }); toast("started"); openAgent(r.id); });
}

function itemHtml(i, last) {
	if (i.kind === "user") return '<div class="item user">' + h(i.text) + "</div>";
	if (i.kind === "agent") return '<div class="item agent' + (i.streaming && last ? " streaming" : "") + '">' + markdown(i.text) + "</div>";
	if (i.kind === "tool" && i.tool) return '<details class="item"><summary><b>' + h(i.tool.name) + "</b> " + h(i.tool.summary) + "</summary>" + (i.tool.output ? "<pre>" + h(i.tool.output) + "</pre>" : "") + "</details>";
	return '<div class="item info">' + h(i.text) + "</div>";
}

function renderAgent() {
	const a = state.agents.find((x) => x.id === state.open);
	if (!a) { state.open = null; return renderList(); }
	const nearBottom = innerHeight + scrollY >= document.body.scrollHeight - 80;
	const open = new Set([...document.querySelectorAll("details[open]")].map((d) => d.dataset.i));
	const draft = document.getElementById("t")?.value || "";
	const hadFocus = document.activeElement?.id === "t";
	$app.innerHTML = header(h(a.name), true) +
		'<main><div class="meta" style="white-space:normal">' + meta(a) + ' · <span class="badge ' + h(a.state) + '">' + h(a.state) + "</span></div>" +
		(state.items.length ? state.items.map((i, n) => itemHtml(i, n === state.items.length - 1).replace("<details", '<details data-i="' + n + '"' + (open.has(String(n)) ? " open" : ""))).join("") : '<div class="note">Nothing yet.</div>') +
		"</main>" + composer(a.state === "running" ? "Queue a follow-up…" : "Follow up…", a.state === "running");
	document.getElementById("back").onclick = () => { state.open = null; history.back(); };
	const t = document.getElementById("t"); t.value = draft; if (hadFocus) t.focus();
	wireComposer(async (text) => { const r = await api("/api/agents/" + a.id + "/prompt", { text }); toast(r.queued ? "queued" : "sent"); });
	if (nearBottom) scrollTo(0, document.body.scrollHeight);
}

let loading = null;
async function loadAgent() {
	if (state.open === null) return;
	if (loading) { loading.again = true; return; }
	loading = { again: false };
	try {
		const r = await api("/api/agents/" + state.open);
		state.items = r.items; state.version = r.agent.version;
		if (state.open === r.agent.id) renderAgent();
	} catch (err) { if (err.auth) return renderLogin(err.message); toast(err.message); }
	const again = loading.again; loading = null;
	if (again) loadAgent();
}

function openAgent(id) {
	state.open = id; state.items = []; state.version = -1;
	history.pushState({ id }, "", "#agent-" + id);
	renderAgent(); scrollTo(0, 0); loadAgent();
}
addEventListener("popstate", () => { if (state.open !== null) { state.open = null; renderList(); } });

let source;
function listen() {
	source?.close();
	source = new EventSource("/api/events?code=" + encodeURIComponent(code));
	source.onopen = () => { state.live = true; document.querySelector(".dot")?.classList.add("live"); };
	source.onerror = () => { state.live = false; document.querySelector(".dot")?.classList.remove("live"); };
	source.addEventListener("agents", (e) => {
		state.agents = JSON.parse(e.data).agents;
		if (state.open === null) return renderList();
		const a = state.agents.find((x) => x.id === state.open);
		if (!a) { state.open = null; return renderList(); }
		if (a.version !== state.version) loadAgent(); else renderAgent();
	});
}

async function start() {
	if (!code) return renderLogin();
	try {
		const r = await api("/api/state");
		state.project = r.project; state.agents = r.agents;
		renderList(); listen();
	} catch (err) { renderLogin(err.auth ? err.message : "can't reach vigent: " + err.message); }
}
start();
</script>
</body>
</html>
`;
}
