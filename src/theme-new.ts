/** `vigent theme new`: a commented theme file, pre-filled with the colors of the theme it starts from. */
import { extractPalette, loadTheme } from "./theme.js";

/** A commented theme file: start from a theme, and recolor it from a palette pre-filled with that theme's colors. */
export function themeNewTemplate(name: string, from: string, opts: { transparent?: boolean; palette?: boolean } = {}): string {
	const base = loadTheme(from);
	const p = extractPalette(base);
	const transparent = opts.transparent ?? Boolean(base.transparent);
	const row = (key: keyof typeof p, note = "") => `${opts.palette ? "" : "# "}${`${key} = "${p[key]}"`.padEnd(24)}${note ? `# ${note}` : ""}`.trimEnd();
	return `# ${name}: a vigent theme. Edit, then :colorscheme ${name} to see it (the picker previews live).
# Docs: https://github.com/farming-labs/vigent/blob/main/docs/themes.md
name = "${name}"
${opts.palette ? `# made from ${from}'s colors` : `\n# Start from any built-in or installed theme, then change what you like.\nextends = "${from}"`}

# Draw on the terminal's own background (its blur, opacity or wallpaper shows
# through). Selections, the cursorline and mode badges keep their colors.
transparent = ${transparent}

# ${opts.palette ? "The whole theme comes from these colors" : "Uncomment [palette] to recolor the whole theme from these colors"}
# (${from}'s, read from its highlight groups). Only bg, fg and the six accents
# are required; leave out the rest and vigent derives them.
${opts.palette ? "" : "# "}[palette]
${row("bg", "background")}
${row("fg", "text")}
${row("red")}
${row("yellow")}
${row("green")}
${row("cyan")}
${row("blue")}
${row("magenta")}
${row("bg_dark", "sidebar, floats")}
${row("bg_alt", "cursorline, statusline")}
${row("selection", "visual selection")}
${row("muted", "comments")}
${row("subtle", "line numbers, separators")}
${row("orange")}
${row("accent", "current line number")}

# Any highlight group, by its Neovim name: a table, a :hi string, or a group to link to.
# These win over extends and [palette]. Tweak live with :hi, then :theme save ${name}!
[groups]
# Normal = { fg = "${p.fg}", bg = "${p.bg}" }
# Comment = "guifg=${p.muted} gui=italic"
# VigentSidebar = { bg = "${p.bg_dark}" }
# VigentModeNormal = { fg = "${p.bg}", bg = "${p.blue}", bold = true }
# VigentModeInsert = { fg = "${p.bg}", bg = "${p.green}", bold = true }
# FloatBorder = { fg = "${p.blue}" }
# CursorLineNr = "Title"
`;
}
