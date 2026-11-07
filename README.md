# vigent

A vim-style, lightweight terminal app for running several coding agents at once, built on the [pi](https://github.com/badlogic/pi-mono) engine.

![vigent with the default Neovim theme](docs/screenshots/vigent-default-theme.png)

![vigent with the gruvbox theme, second session focused](docs/screenshots/vigent-gruvbox.png)

## Quick start

```bash
npm install
npm run build
npm run demo      # scripted sessions, no API key needed
npm test          # build and run the test suite
```

With a provider key set (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`), `npm start` runs a real pi agent session instead of the demo.

## Keys

| Mode | Key | Action |
|---|---|---|
| NORMAL | `i` / `a` / `o` | Enter INSERT and type a prompt for the focused agent (it waits in a queue if the agent is busy) |
| NORMAL | `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` `{` `}` | Scroll the transcript, or jump between messages |
| NORMAL | `]s` `[s` `1`–`9` `Ctrl-^` | Switch agents |
| NORMAL | `za` `zR` `zM` | Toggle, open or close tool-output folds |
| NORMAL | `/pattern` `?pattern` `n` `N` | Search the transcript, forward or backward |
| NORMAL | `V` / `v` | VISUAL: select lines with `j` `k`, `ib` for a code block, `y` to copy |
| NORMAL | `yy` / `yib` | Copy the agent's last reply / the nearest code block |
| NORMAL | `dd` | Kill the focused agent (asks first) |
| NORMAL | `<Space>n` `d` `m` `p` `q` `t` `D` | `:new`, `:diff`, `:merge`, `:pr`, `:queue`, colorscheme, `:dash` |
| INSERT | `Enter` / `Esc` | Send the prompt / back to NORMAL |

Copies go to the system clipboard through the terminal (OSC 52), so they work over SSH too. `:help` lists every active key, including yours.

![Neovim-style intro screen](docs/screenshots/intro.png)

![VISUAL mode on a markdown reply](docs/screenshots/visual-mode.png)

## Worktrees

Every agent gets its own git worktree and branch, so agents never touch your checkout or each other's files:

```vim
:new fix flaky checkout test     " branch fix/flaky-checkout-test in ../<repo>-worktrees/fix-flaky-checkout-test
:new auth-refactor               " branch refactor/auth
:diff                            " what the focused agent changed, new files included
:worktrees                       " list them
:kill                            " stop the agent, keep its work  (:kill! also removes the worktree, safely)
```

Branch names follow the usual conventions (`fix/…`, `feat/…`, `docs/…`, `refactor/…`) and are taken from the task you type. The sidebar and statusline show each agent's branch with live `+added −removed` counts. Removing a worktree goes through git's own safety checks, so uncommitted or unmerged work is never thrown away. Folder, branch pattern and base branch are set in `[worktree]` ([docs/config.md](docs/config.md#worktree)).

![agents in their own worktrees](docs/screenshots/worktrees-sidebar.png)

![:diff](docs/screenshots/worktrees-diff.png)

## Reviewing and landing work

```vim
:diff                  " the agent's changes; ]c / [c jump between hunks
:merge                 " squash-merge its branch into yours: one commit, e.g. "fix: flaky checkout test"
:merge --no-squash     " a regular merge commit instead
:pr                    " push the branch and open a pull request (gh), or print the compare URL
:dash                  " every agent at a glance; j/k and Enter to jump to one
:queue <prompt>        " send a follow-up after the current run (:queue alone lists them)
:pause  /  :resume     " hold an agent and its queue, then continue
:w [file]              " save the transcript as Markdown
```

`:merge` and `:pr` first commit anything the agent left uncommitted. `:merge` only touches your checkout when it's on the agent's base branch with no uncommitted changes, and a conflict is rolled back so nothing changes. After a merge, `:kill!` removes the worktree and the merged branch. `:q` won't quit while agents are running; `:q!` or `ZQ` does. Use `:new <task> --model <id>` to give one agent a different model.

![:merge](docs/screenshots/merge.png)

![:dash](docs/screenshots/dashboard.png)

## Configuration

Everything lives in `~/.config/vigent/config.toml`. `vigent config init` writes a commented starter file, and `vigent config check` validates it. Keys use vim notation, and the right-hand side can be an action, an ex command or other keys:

```toml
theme = "tokyonight"
leader = "<Space>"

[ui]
sidebar_width = 32
timeoutlen = 500

[highlights]
Normal = { bg = "NONE" }

[keys.normal]
"<leader>t" = "theme.picker"          # an action
"<leader>n" = ":new "                 # open the command line, ready to type
"<leader>d" = ":colorscheme default<CR>"
"<Tab>" = "session.next"
"H" = "gg"                            # other keys, with their built-in meaning
"q" = false                           # unbind

[keys.insert]
"jk" = "<Esc>"
```

You can also change keys while vigent runs, with `:nmap`, `:imap`, `:cmap`, `:unmap` and `:let mapleader`. **[docs/config.md](docs/config.md)** has every option, action and built-in key.

![:help lists every key, yours first](docs/screenshots/keys-help.png)

## Themes

vigent speaks Neovim's highlight groups (`Normal`, `StatusLine`, `CursorLine`, …), so your vim or Neovim theme carries straight over.

```bash
vigent theme import                 # whatever colorscheme your nvim/vim config uses
vigent theme import kanagawa        # any colorscheme your editor can load (plugins included)
vigent theme import ./molokai.vim   # a .vim file, no editor needed
vigent theme new mine --from nord   # start your own theme
```

Inside vigent, `:colorscheme` opens a picker with live preview. `:hi Group guifg=… guibg=…` changes any color on the spot, and `:set` toggles UI options. To keep changes, put them in `~/.config/vigent/config.toml` (`vigent config init` writes a starter file):

```toml
theme = "tokyonight"

[ui]
sidebar_width = 34
icons = "unicode"      # or "ascii"

[highlights]           # applied on top of any theme
Normal = { bg = "NONE" }
CursorLine = "guibg=#2a2f3a"
```

Built in: `default` (Neovim's default look), `gruvbox`, `tokyonight`, `catppuccin`, `catppuccin-latte`, `nord`, `rose-pine`, `kanagawa`.

![colorscheme picker with live preview](docs/screenshots/colorscheme-picker.png)

![habamax imported from Neovim](docs/screenshots/imported-habamax.png)

![nord with :hi and :set changes applied live](docs/screenshots/live-customization.png)

The full guide covers importing, theme files, palettes, every option and every highlight group: **[docs/themes.md](docs/themes.md)**.

## Layout

```
src/
  cli.ts             entry point, flags, `theme` and `config` subcommands
  app.ts             the modal TUI (modes, keys, sidebar, transcript, statusline, cmdline)
  picker.ts          floating :colorscheme picker
  theme.ts           highlight-group engine: resolution, overrides, theme files
  builtin-themes.ts  built-in themes
  palette.ts         builds a full theme from a small palette
  import.ts          imports colorschemes from nvim / vim (headless) or .vim files
  vimcolors.ts       :highlight syntax and the static .vim colorscheme reader
  color.ts           hex math, xterm-256 colors, vim color names
  config.ts          config.toml, ui options and :set
  session.ts         Session model; PiSession (real engine) and DemoSession
  demo.ts            scripted demo sessions
test/                node:test suites (npm test)
```

See [DESIGN.md](DESIGN.md) for the full plan and milestones.
