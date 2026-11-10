/**
 * A style: how vigent lays things out, apart from its colors. A theme can
 * carry one (a `[style]` table in its file), and `[style]` in config.toml
 * overrides it field by field:
 *
 *   [style]
 *   sidebar = "cards"         # tree (default), cards, compact
 *   messages = "bubbles"      # plain (default), labeled, bubbles
 *   tool_icons = "unicode"    # none, unicode, nerd (default: nerd with icons = "nerd", else none)
 *   user_label = "you"        # what labeled and bubble messages call you
 *
 *   [style.icons]             # any glyph by name, over the icon set
 *   prompt = "λ "
 *   worktree = "⑂ "
 *   idle = "◇"                # agent states: idle, waiting, paused, error
 */

export const SIDEBAR_STYLES = ["tree", "cards", "compact"] as const;
export const MESSAGE_STYLES = ["plain", "labeled", "bubbles"] as const;
export const TOOL_ICON_STYLES = ["none", "unicode", "nerd"] as const;
export type SidebarStyle = (typeof SIDEBAR_STYLES)[number];
export type MessageStyle = (typeof MESSAGE_STYLES)[number];
export type ToolIconStyle = (typeof TOOL_ICON_STYLES)[number];

/** Glyphs a style may replace (the agent states are idle, waiting, paused, error). */
export const ICON_NAMES = [
	"prompt",
	"worktree",
	"folded",
	"open",
	"cursor",
	"bullet",
	"queued",
	"open_agent",
	"here",
	"unread",
	"light",
	"ok",
	"warn",
	"off",
	"sep",
	"idle",
	"waiting",
	"paused",
	"error",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** What a theme file or config.toml sets; anything left out comes from below it. */
export interface StyleSpec {
	sidebar?: SidebarStyle;
	messages?: MessageStyle;
	tool_icons?: ToolIconStyle;
	user_label?: string;
	icons?: Partial<Record<IconName, string>>;
}

/** The style in effect. */
export interface Style {
	sidebar: SidebarStyle;
	messages: MessageStyle;
	/** undefined: follow the icon set */
	toolIcons?: ToolIconStyle;
	userLabel: string;
	icons: Partial<Record<IconName, string>>;
}

export const DEFAULT_STYLE: Style = { sidebar: "tree", messages: "plain", userLabel: "You", icons: {} };

/** Layer styles, lowest first: the default, the theme's, yours. */
export function resolveStyle(...layers: (StyleSpec | undefined)[]): Style {
	const s: Style = { ...DEFAULT_STYLE, icons: {} };
	for (const l of layers) {
		if (!l) continue;
		if (l.sidebar) s.sidebar = l.sidebar;
		if (l.messages) s.messages = l.messages;
		if (l.tool_icons) s.toolIcons = l.tool_icons;
		if (l.user_label) s.userLabel = l.user_label;
		if (l.icons) Object.assign(s.icons, l.icons);
	}
	return s;
}

/** Read a `[style]` table. Mistakes are warnings; the rest of it still counts. */
export function parseStyle(value: unknown, where: string, warnings: string[]): StyleSpec {
	const out: StyleSpec = {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${where}: [style] should be a table, e.g. sidebar = "cards"`);
		return out;
	}
	const oneOf = <T extends string>(k: string, v: unknown, allowed: readonly T[]): T | undefined => {
		if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
		warnings.push(`${where} [style]: '${k}' should be ${allowed.map((a) => `"${a}"`).join(", ")}`);
		return undefined;
	};
	for (const [k, v] of Object.entries(value)) {
		switch (k) {
			case "sidebar":
				out.sidebar = oneOf(k, v, SIDEBAR_STYLES);
				break;
			case "messages":
				out.messages = oneOf(k, v, MESSAGE_STYLES);
				break;
			case "tool_icons":
				out.tool_icons = oneOf(k, v, TOOL_ICON_STYLES);
				break;
			case "user_label":
				if (typeof v === "string" && v.trim()) out.user_label = v.trim();
				else warnings.push(`${where} [style]: 'user_label' should be a string`);
				break;
			case "icons":
				if (!v || typeof v !== "object" || Array.isArray(v)) {
					warnings.push(`${where} [style]: 'icons' should be a table, e.g. prompt = "λ "`);
					break;
				}
				out.icons = {};
				for (const [name, glyph] of Object.entries(v)) {
					if (!(ICON_NAMES as readonly string[]).includes(name)) warnings.push(`${where} [style.icons]: unknown icon '${name}' (${ICON_NAMES.join(", ")})`);
					else if (typeof glyph !== "string") warnings.push(`${where} [style.icons]: '${name}' should be a string`);
					else out.icons[name as IconName] = glyph;
				}
				break;
			default:
				warnings.push(`${where} [style]: unknown option '${k}' (sidebar, messages, tool_icons, user_label, icons)`);
		}
	}
	for (const k of Object.keys(out) as (keyof StyleSpec)[]) if (out[k] === undefined) delete out[k];
	return out;
}

/** Tool-call glyphs without a Nerd Font. */
export const UNICODE_TOOL_ICONS = {
	terminal: "▶",
	pencil: "✎",
	fileText: "☰",
	search: "⌕",
	globe: "◍",
	list: "☑",
	wrench: "⚙",
} as const;
