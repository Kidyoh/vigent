/** `:w`: write the focused agent's transcript as Markdown. */
import type { Session } from "./session.js";

export function transcriptMarkdown(s: Session, now = new Date()): string {
	const out: string[] = [`# ${s.name}`, ""];
	const meta = [`model: ${s.model}`];
	if (s.worktree) meta.push(`branch: \`${s.worktree.branch}\``);
	if (s.worktree?.stat) meta.push(`changes: +${s.worktree.stat.added} −${s.worktree.stat.removed}`);
	meta.push(`exported: ${now.toISOString().replace("T", " ").slice(0, 16)}`);
	out.push(meta.join(" · "), "");
	for (const item of s.items) {
		switch (item.kind) {
			case "user":
				out.push(`## You`, "", item.text, "");
				break;
			case "agent":
				out.push(`## Agent`, "", item.text, "");
				break;
			case "tool": {
				const t = item.tool!;
				out.push(`<details><summary><code>${t.name}</code> ${t.summary}</summary>`, "", "```", t.output.trimEnd(), "```", "", "</details>", "");
				break;
			}
			case "info":
				out.push(`> ${item.text}`, "");
				break;
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}
