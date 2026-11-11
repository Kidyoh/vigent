/**
 * `:race <task>`: the same task on several engines at once, each in its own
 * worktree, so you can compare what they did and keep the one you like.
 */
import type { Session } from "./session.js";

/** One entrant: an engine, and a model for it when you asked for one (`claude:opus`). */
export interface Racer {
	engine: string;
	model?: string;
}

export interface RaceArgs {
	task: string;
	/** undefined = every engine that's signed in */
	racers?: Racer[];
	template?: string;
	error?: string;
}

/**
 * `fix the flaky test --engines claude,codex:gpt-5.5 -t fix`
 * An engine can be there twice (`claude,claude`, or `claude:opus,claude:sonnet`).
 */
export function parseRaceArgs(arg: string): RaceArgs {
	const ENGINES = /(?:^|\s)(?:--engines?|-e)[= ](\S+)/;
	const TEMPLATE = /(?:^|\s)(?:--template|-t)[= ](\S+)/;
	const engines = ENGINES.exec(arg);
	const template = TEMPLATE.exec(arg);
	const task = arg.replace(ENGINES, "").replace(TEMPLATE, "").trim();
	const out: RaceArgs = { task, ...(template ? { template: template[1] } : {}) };
	if (!engines) return out;
	const racers: Racer[] = [];
	for (const part of engines[1].split(",")) {
		if (!part) continue;
		const colon = part.indexOf(":");
		const engine = colon < 0 ? part : part.slice(0, colon);
		const model = colon < 0 ? "" : part.slice(colon + 1);
		if (!engine) return { ...out, error: `'${part}' names a model but no engine (write engine:model)` };
		racers.push({ engine, ...(model ? { model } : {}) });
	}
	if (racers.length < 2) return { ...out, error: "a race needs at least two: --engines claude,codex (the same one twice works too)" };
	return { ...out, racers };
}

/**
 * What tells the racers apart in an agent's name (and so in its branch): the
 * engine, the model too when one engine runs with several, and a number when
 * the same one runs more than once.
 */
export function racerLabels(racers: Racer[]): string[] {
	const perEngine = new Map<string, Set<string>>();
	for (const r of racers) perEngine.set(r.engine, (perEngine.get(r.engine) ?? new Set()).add(r.model ?? ""));
	const plain = racers.map((r) => ((perEngine.get(r.engine)?.size ?? 1) > 1 && r.model ? `${r.engine} ${r.model}` : r.engine));
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
