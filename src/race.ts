/**
 * `:race <task>`: the same task on several engines at once, each in its own
 * worktree, so you can compare what they did and keep the one you like.
 */
import type { Session } from "./session.js";
import { didYouMean } from "./suggest.js";

/** One entrant: an engine, and a model for it when you asked for one (`claude:opus`, or `--models claude-opus-5-5`). */
export interface Racer {
	engine: string;
	model?: string;
}

export interface RaceArgs {
	task: string;
	/** from `--engines`; with no `--models` either, every engine that's signed in races */
	racers?: Racer[];
	/** from `--models`: model ids, each racing on the engine whose list has it */
	models?: string[];
	template?: string;
	error?: string;
}

/**
 * `fix the flaky test --engines claude,codex:gpt-5.5 --models claude-opus-5-5 -t fix`
 * An engine or a model can be there twice (`claude,claude`, `--models gpt-5.5,gpt-5.5`).
 */
export function parseRaceArgs(arg: string): RaceArgs {
	const ENGINES = /(?:^|\s)(?:--engines?|-e)[= ](\S+)/;
	const MODELS = /(?:^|\s)(?:--models?|-m)[= ](\S+)/;
	const TEMPLATE = /(?:^|\s)(?:--template|-t)[= ](\S+)/;
	const engines = ENGINES.exec(arg);
	const models = MODELS.exec(arg);
	const template = TEMPLATE.exec(arg);
	const task = arg.replace(ENGINES, "").replace(MODELS, "").replace(TEMPLATE, "").trim();
	const out: RaceArgs = { task, ...(template ? { template: template[1] } : {}) };
	if (!engines && !models) return out;
	const racers: Racer[] = [];
	for (const part of engines?.[1].split(",") ?? []) {
		if (!part) continue;
		const colon = part.indexOf(":");
		const engine = colon < 0 ? part : part.slice(0, colon);
		const model = colon < 0 ? "" : part.slice(colon + 1);
		if (!engine) return { ...out, error: `'${part}' names a model but no engine (write engine:model, or put it in --models)` };
		racers.push({ engine, ...(model ? { model } : {}) });
	}
	const ids = models?.[1].split(",").filter(Boolean) ?? [];
	if (racers.length + ids.length < 2) return { ...out, error: "a race needs at least two: --engines claude,codex or --models claude-opus-5-5,gpt-5.5 (the same one twice works too)" };
	return { ...out, ...(engines ? { racers } : {}), ...(models ? { models: ids } : {}) };
}

/** Engines that make their own models: a model one of them lists is theirs, even when an engine that routes to many lists it too. */
const MAKERS = ["claude", "codex", "gemini", "cursor"];

/**
 * `--models` ids to racers. Each id runs on the engine whose model list has it
 * exactly (`known`: engine → the ids and aliases it takes). `engine:model` runs
 * one on the engine you name, for a model no list has or one several lists share.
 * An id no list has, one that's in more than one, or one whose engine isn't
 * signed in is refused: a race never moves a model to another engine.
 */
export function resolveRaceModels(
	ids: string[],
	known: Map<string, string[]>,
	/** why an engine can't run a model now ("Claude Code, which isn't signed in"), or undefined when it can */
	blocked: (engine: string) => string | undefined,
): { racers: Racer[] } | { error: string } {
	const racers: Racer[] = [];
	for (const id of ids) {
		const colon = id.indexOf(":");
		if (colon > 0 && known.has(id.slice(0, colon))) {
			racers.push({ engine: id.slice(0, colon), model: id.slice(colon + 1) });
			continue;
		}
		let owners = [...known].filter(([, list]) => list.includes(id)).map(([e]) => e);
		if (owners.length > 1 && owners.some((e) => MAKERS.includes(e))) owners = owners.filter((e) => MAKERS.includes(e));
		if (owners.length === 0) {
			const all = new Set([...known.values()].flat());
			return { error: `no engine lists the model '${id}'${didYouMean(id, all)} · engine:model runs one that isn't listed` };
		}
		if (owners.length > 1) return { error: `'${id}' runs on ${owners.join(" and ")}: say which, as ${owners.map((e) => `${e}:${id}`).join(" or ")}` };
		const on = owners[0];
		const why = blocked(on);
		if (why) return { error: `${id} runs on ${why} · :checkhealth` };
		racers.push({ engine: on, model: id });
	}
	return { racers };
}

/**
 * What tells the racers apart in an agent's name (and so in its branch): the
 * model when it has one (the exact id you gave), else the engine, and a number
 * when the same one runs more than once.
 */
export function racerLabels(racers: Racer[]): string[] {
	const plain = racers.map((r) => r.model ?? r.engine);
	const total = new Map<string, number>();
	for (const p of plain) total.set(p, (total.get(p) ?? 0) + 1);
	const seen = new Map<string, number>();
	return plain.map((p) => {
		if ((total.get(p) ?? 1) < 2) return p;
		const n = (seen.get(p) ?? 0) + 1;
		seen.set(p, n);
		return `${p} ${n}`;
	});
}

/** What Tab offers after `:race … --engines` / `--models`: the last item of the comma list. */
export function completeRaceArg(arg: string, sources: { engines: string[]; models: string[] }): { base: string; items: string[] } | undefined {
	const m = /(?:^|\s)(--engines?|-e|--models?|-m)([= ])((?:[^\s,]*,)*)([^\s,]*)$/.exec(arg);
	if (m) {
		const list = /^(--engines?|-e)$/.test(m[1]) ? sources.engines : sources.models;
		const needle = m[4].toLowerCase();
		return { base: arg.slice(0, arg.length - m[4].length), items: list.filter((x) => x.toLowerCase().startsWith(needle)) };
	}
	const flag = /(?:^|\s)(-[-a-z]*)$/.exec(arg);
	if (flag) return { base: arg.slice(0, arg.length - flag[1].length), items: ["--engines", "--models", "--template"].filter((f) => f.startsWith(flag[1])) };
	return undefined;
}

export interface Race {
	id: number;
	task: string;
	startedAt: number;
	racers: Session[];
	/** the racers that have started on the task */
	ran: Set<Session>;
	/** when each racer first stopped running */
	finishedAt: Map<Session, number>;
	/** you've been told that every racer is done */
	announced: boolean;
}

/** Every racer has stopped at least once (finished, failed or needs you). */
export function raceOver(race: Race): boolean {
	return race.racers.length > 0 && race.racers.every((s) => race.finishedAt.has(s));
}

/** The racers, first to finish first; the ones still running last, in the order they started. */
export function raceOrder(race: Race): Session[] {
	return [...race.racers].sort((a, b) => (race.finishedAt.get(a) ?? Infinity) - (race.finishedAt.get(b) ?? Infinity));
}
