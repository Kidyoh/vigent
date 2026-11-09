/**
 * What the statusline and the winbar show, and in which order, like lualine's sections:
 *
 *   [statusline]
 *   left = ["mode", "agent", "branch"]
 *   right = ["model", "usage", "agents"]
 *
 *   [winbar]
 *   left = ["agent", "model", "status"]
 *   right = ["path"]
 */

export const STATUSLINE_PARTS = ["mode", "agent", "branch", "engine", "model", "effort", "usage", "agents", "path", "clock"] as const;
export const WINBAR_PARTS = ["agent", "model", "engine", "effort", "status", "path", "branch", "usage"] as const;
export type StatuslinePart = (typeof STATUSLINE_PARTS)[number];
export type WinbarPart = (typeof WINBAR_PARTS)[number];

export interface Sections<P extends string> {
	left: P[];
	right: P[];
}

export interface Layout {
	statusline: Sections<StatuslinePart>;
	winbar: Sections<WinbarPart>;
}

export const DEFAULT_LAYOUT: Layout = {
	statusline: { left: ["mode", "agent", "branch"], right: ["model", "usage", "agents"] },
	winbar: { left: ["agent", "model", "status"], right: ["path"] },
};

export function defaultLayout(): Layout {
	return {
		statusline: { left: [...DEFAULT_LAYOUT.statusline.left], right: [...DEFAULT_LAYOUT.statusline.right] },
		winbar: { left: [...DEFAULT_LAYOUT.winbar.left], right: [...DEFAULT_LAYOUT.winbar.right] },
	};
}

/** [statusline] / [winbar]: `left` and `right`, each a list of parts. Mistakes are warnings. */
export function parseSections<P extends string>(
	table: string,
	value: unknown,
	parts: readonly P[],
	into: Sections<P>,
	where: string,
	warnings: string[],
): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${where}: [${table}] should be a table with left = [...] and right = [...]`);
		return;
	}
	for (const [side, list] of Object.entries(value)) {
		if (side !== "left" && side !== "right") {
			warnings.push(`${where} [${table}]: unknown option '${side}' (left, right)`);
			continue;
		}
		if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) {
			warnings.push(`${where} [${table}]: '${side}' should be a list, e.g. ["${parts[0]}", "${parts[1]}"]`);
			continue;
		}
		const ok: P[] = [];
		for (const p of list as string[]) {
			if ((parts as readonly string[]).includes(p)) ok.push(p as P);
			else warnings.push(`${where} [${table}]: unknown part '${p}' (${parts.join(", ")})`);
		}
		into[side] = ok;
	}
}
