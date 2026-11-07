# Themes and customization

vigent uses **Neovim's highlight group names** (`Normal`, `StatusLine`, `CursorLine`, `Visual`, `Comment`, `DiffAdd`, …) for every color it draws. Any vim or Neovim colorscheme maps onto vigent directly, and anything you already know about `:highlight` works here too.

## Quick reference

| I want to… | Do this |
|---|---|
| Use my Neovim/Vim theme | `vigent theme import` (reads whatever your editor config uses) |
| Use a specific vim/nvim colorscheme | `vigent theme import tokyonight` |
| Use a `.vim` colorscheme file | `vigent theme import ./molokai.vim` (no editor needed) |
| Pick a theme interactively | `:colorscheme` inside vigent (live preview) |
| Set my default theme | `theme = "…"` in `~/.config/vigent/config.toml` |
| Tweak a few colors | `[highlights]` in config.toml, or `:hi Group guifg=… guibg=…` |
| Make my own theme | `vigent theme new mytheme --from tokyonight` |

Files live in `~/.config/vigent/` (or `$XDG_CONFIG_HOME/vigent/`). `vigent theme path` prints the exact location.

## Built-in themes

`default` (Neovim's default dark theme), `gruvbox`, `tokyonight`, `catppuccin`, `catppuccin-latte`, `nord`, `rose-pine`, `kanagawa`.

## Importing vim and Neovim colorschemes

```bash
vigent theme import                     # the colorscheme your nvim (or vim) config sets
vigent theme import catppuccin-frappe   # any colorscheme your editor can load
vigent theme import gruvbox-material --as gm
vigent theme import ./colors/molokai.vim
```

vigent runs your editor headless with your normal config, so colorschemes installed with lazy.nvim, packer, vim-plug or native packages load the same way they do when you edit. It then saves every resolved highlight group to `~/.config/vigent/themes/<name>.json`. If loading with your config fails, it retries with a clean editor (`--clean`), and then with the other editor.

Options:

| Flag | Meaning |
|---|---|
| `--as <name>` | save under a different name |
| `--nvim`, `--vim` | use only this editor (default: try nvim, then vim) |
| `--light`, `--dark` | set `'background'` first, for themes with both variants |
| `--clean` | skip your editor config (faster; plugin-installed themes won't load) |

Requirements: Neovim 0.9+ or Vim 9+ for the most accurate import. Older versions still work through their `:highlight` listing. Without either editor, `.vim` files are read directly. That covers the classic `hi Group guifg=… guibg=…` style, including `&background` branches and links. Themes written in Lua, or built with functions at runtime, need nvim.

Terminal-only themes (only `ctermfg`/`ctermbg`) are converted with the standard xterm-256 palette. Vim color names (`LightBlue`, `grey40`, …) are converted to hex.

Groups a theme doesn't define fall back the way Neovim's do, so a partial theme still looks complete. vigent's own groups are derived from the theme when it doesn't set them:

- **Mode badges** take their color from `Function`, `String`, `Statement` and `WarningMsg`.
- **Sidebar** uses `NeoTreeNormal` or `NvimTreeNormal` if the theme styles them, otherwise a slightly darker `Normal` background.

## Inside vigent

```vim
:colorscheme                 " floating picker: type to filter, ↑/↓ or Ctrl-n/Ctrl-p preview, Enter keeps, Esc cancels
:colorscheme nord            " switch directly (also :colo, :theme)
:hi Comment guifg=#7a88cf gui=italic
:hi VigentModeNormal guibg=#ebcb8b guifg=#2e3440 gui=bold
:hi link VigentUser String
:hi Normal                   " show a group, like vim: Normal xxx guifg=… guibg=…
:hi clear Comment            " undo your change to one group (:hi clear undoes all)
```

`:hi` accepts vim's keys (`guifg`, `guibg`, `gui`, `ctermfg`, `ctermbg`, `cterm`), the shorter `fg=`/`bg=`, and bare attributes like `bold`. Your `:hi` changes stay in place when you switch colorschemes. They last until you quit; put them in config.toml to keep them.

## config.toml

`vigent config init` writes a commented starter file. Keys, leader and every other setting are covered in [config.md](config.md).

```toml
theme = "tokyonight"

[ui]
sidebar = true
sidebar_width = 30
number = true        # session numbers in the sidebar
tilde = true         # ~ on empty sidebar rows
icons = "unicode"    # "ascii" for fonts without box-drawing characters

# Applied on top of whichever theme is active, including after :colorscheme.
[highlights]
Normal = { bg = "NONE" }                  # transparent: use the terminal's background
CursorLine = "guibg=#2a2f3a"              # vim :hi syntax works too
VigentSidebar = "NormalFloat"             # a bare name links to that group
VigentModeInsert = { fg = "#1a1b26", bg = "#9ece6a", bold = true }
```

Unlike `nvim_set_hl`, an override **merges** with the theme's definition. `Normal = { bg = "NONE" }` keeps the theme's foreground and only drops the background. Use `"NONE"` for either color to fall through to the terminal's own color.

Mistakes in the config never stop vigent from starting. They show up as a warning on the command line instead.

The UI options can also be changed live with vim-style `:set`:

```vim
:set nonumber       :set number!       :set notilde
:set sidebar_width=40                  :set icons=ascii
:set                " show all options
```

## Writing your own theme

```bash
vigent theme new midnight --from tokyonight
```

This creates `~/.config/vigent/themes/midnight.toml`. A theme file can do any combination of three things.

**Extend** another theme and change a few groups:

```toml
extends = "tokyonight"

[groups]
Normal = { bg = "#0f0f17" }
VigentSidebar = { bg = "#0a0a10" }
CursorLineNr = "Title"
```

**Describe a palette** and let vigent derive every group from it. Only `bg`, `fg` and the six accents are required:

```toml
name = "midnight"

[palette]
bg = "#0b0e14"
fg = "#bfbdb6"
red = "#f07178"
yellow = "#ffb454"
green = "#aad94c"
cyan = "#95e6cb"
blue = "#59c2ff"
magenta = "#d2a6ff"
# optional: bg_dark (sidebar), bg_alt (cursorline/statusline), selection,
#           muted (comments), subtle (line numbers), orange, accent
```

**List groups** explicitly, as a table, a `:hi` string, or a link name:

```toml
[groups]
Normal = { fg = "#e0e2ea", bg = "#14161b" }
Comment = "guifg=#9b9ea4 gui=italic"
WinSeparator = "NonText"
```

JSON works too (`midnight.json` with the same keys), and so does a plain `.vim` colorscheme dropped into the themes folder.

## Highlight groups vigent uses

Standard Neovim groups: `Normal`, `NormalFloat`, `FloatBorder`, `FloatTitle`, `StatusLine`, `StatusLineNC`, `WinBar`, `WinSeparator`, `CursorLine`, `CursorLineNr`, `LineNr`, `EndOfBuffer`, `NonText`, `Comment`, `Title`, `Keyword`, `Function`, `String`, `Search`, `Visual`, `Pmenu`, `PmenuSel`, `ErrorMsg`, `WarningMsg`, `ModeMsg`, `MsgArea`.

Tree-plugin groups (picked up from imported themes): `NeoTreeNormal`, `NvimTreeNormal`, `NeoTreeIndentMarker`, `NvimTreeIndentMarker`.

vigent's own groups:

| Group | Used for | Default |
|---|---|---|
| `VigentSidebar` | sidebar background | `NeoTreeNormal` → `NvimTreeNormal` → shaded `Normal` |
| `VigentIndent` | sidebar tree guides | `NeoTreeIndentMarker` → `NonText` |
| `VigentModeNormal`, `VigentModeInsert`, `VigentModeVisual`, `VigentModeCommand` | statusline mode badge | derived from `Function` / `String` / `Statement` / `WarningMsg` |
| `VigentUser` | the `❯` before your prompts | `Title` |
| `VigentTool` | tool names in the transcript | `Function` |
| `VigentToolOutput` | unfolded tool output | `Comment` |
| `VigentSpinner` | running indicator | `WarningMsg` |
