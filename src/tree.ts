/**
 * `:tree` — the agent's conversation as a tree (pi keeps every branch).
 *
 * Flattens pi's session tree into rows for a floating list: a straight run of
 * messages stays at one level, and only where the conversation branched do
 * the alternatives get ├─ / └─ guides. Tool results are folded into the
 * reply that called them; bookkeeping entries (model changes, labels...) are
 * skipped.
 */

export type TreeKind = "user" | "agent" | "tool" | "summary" | "note";

export interface TreeRow {
	id: string;
	/** tree guides drawn before the row, e.g. "│  ├─ " */
	guide: string;
	kind: TreeKind;
	text: string;
	/** on the branch the agent is on now */
	onPath: boolean;
	/** where the conversation currently ends */
	current: boolean;
	label?: string;
}

/** The shape of pi's SessionTreeNode that we use. */
export interface TreeNodeLike {
	entry: { id: string; parentId: string | null; type: string; [k: string]: any };
	children: TreeNodeLike[];
	label?: string;
}

export interface TreeGlyphs {
	tee: string;
	last: string;
	pipe: string;
	blank: string;
}

export const TREE_GLYPHS: Record<"unicode" | "ascii", TreeGlyphs> = {
	unicode: { tee: "├─ ", last: "└─ ", pipe: "│  ", blank: "   " },
	ascii: { tee: "|- ", last: "`- ", pipe: "|  ", blank: "   " },
};

function textOf(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join(" ");
}

function oneLine(s: string): string {
	return s.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim();
}

/** What a tree entry shows as, or undefined to skip it. */
function describe(entry: TreeNodeLike["entry"]): { kind: TreeKind; text: string } | undefined {
	if (entry.type === "message") {
		const m = entry.message ?? {};
		if (m.role === "user") return { kind: "user", text: oneLine(textOf(m.content)) || "(empty prompt)" };
		if (m.role === "assistant") {
			const text = oneLine(textOf(m.content));
			if (text) return { kind: "agent", text };
			const calls = (Array.isArray(m.content) ? m.content : []).filter((b: any) => b?.type === "toolCall");
			if (calls.length === 0) return undefined;
			const names = calls.map((c: any) => {
				const a = c.arguments ?? {};
				const arg = a.command ?? a.path ?? a.file_path ?? "";
				return `${c.name}${arg ? ` ${String(arg).slice(0, 40)}` : ""}`;
			});
			return { kind: "tool", text: names.join(", ") };
		}
		return undefined; // tool results belong to the call above them
	}
	if (entry.type === "branch_summary") return { kind: "summary", text: `summary of another branch: ${oneLine(entry.summary ?? "")}` };
	if (entry.type === "compaction") return { kind: "note", text: "earlier messages compacted" };
	return undefined;
}

/** Flatten pi's session tree into list rows. */
export function flattenTree(roots: TreeNodeLike[], leafId: string | null, glyphs: TreeGlyphs = TREE_GLYPHS.unicode): TreeRow[] {
	// the current branch: walk up from the leaf
	const parents = new Map<string, string | null>();
	const index = (nodes: TreeNodeLike[]) => {
		for (const n of nodes) {
			parents.set(n.entry.id, n.entry.parentId);
			index(n.children);
		}
	};
	index(roots);
	const onPath = new Set<string>();
	for (let id = leafId; id; id = parents.get(id) ?? null) onPath.add(id);

	// skipped entries hand their children to the nearest shown ancestor
	const visibleChildren = (nodes: TreeNodeLike[]): TreeNodeLike[] =>
		nodes.flatMap((n) => (describe(n.entry) ? [n] : visibleChildren(n.children)));
	// the current position, mapped to the nearest shown entry at or above the leaf
	let current: string | null = null;
	for (let id = leafId; id && current === null; id = parents.get(id) ?? null) {
		const n = find(roots, id);
		if (n && describe(n.entry)) current = id;
	}

	const rows: TreeRow[] = [];
	const emit = (n: TreeNodeLike, guide: string) => {
		const d = describe(n.entry)!;
		rows.push({
			id: n.entry.id,
			guide,
			kind: d.kind,
			text: d.text,
			onPath: onPath.has(n.entry.id),
			current: n.entry.id === current,
			label: n.label,
		});
	};
	const walk = (nodes: TreeNodeLike[], prefix: string) => {
		if (nodes.length === 1) {
			emit(nodes[0], prefix);
			walk(visibleChildren(nodes[0].children), prefix);
			return;
		}
		nodes.forEach((n, i) => {
			const last = i === nodes.length - 1;
			emit(n, prefix + (last ? glyphs.last : glyphs.tee));
			walk(visibleChildren(n.children), prefix + (last ? glyphs.blank : glyphs.pipe));
		});
	};
	walk(visibleChildren(roots), "");
	return rows;
}

function find(nodes: TreeNodeLike[], id: string): TreeNodeLike | undefined {
	for (const n of nodes) {
		if (n.entry.id === id) return n;
		const hit = find(n.children, id);
		if (hit) return hit;
	}
	return undefined;
}
