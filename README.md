# vigent

A vim-style, lightweight terminal app for running several coding agents at once, built on the [pi](https://github.com/badlogic/pi-mono) engine. It can also drive the Claude Code, Codex and OpenCode CLIs you already have installed, with their own logins.

![vigent with the default Neovim theme](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/vigent-default-theme.png)

![vigent with the gruvbox theme, second session focused](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/vigent-gruvbox.png)

## Install

```bash
npm install -g @vigent/cli
```

The package is `@vigent/cli` (npm doesn't accept the plain name `vigent`, which it finds too close to `vitest`); the command is `vigent`. Run `vigent` in a project, or `vigent <folder>` (`vigent .`, `vigent ~/code/app`) from anywhere.

Requires Node.js 20 or newer and git. Then, inside any git repository:

```bash
vigent                    # pi with ANTHROPIC_API_KEY (or OPENAI_API_KEY / GEMINI_API_KEY), or a signed-in CLI
vigent --engine claude    # new agents run your installed Claude Code (also: codex, opencode, pi)
vigent --demo             # scripted agents, nothing needed
vigent --help
```

`vigent --version` shows which vigent runs (with the commit, when it runs from a clone). An older build may be missing a theme or command from these docs, for example `E185: Cannot find color scheme 'lazyvim'`. In a clone, `git pull && npm install` updates and rebuilds it, and vigent warns at startup when its build is older than its source. From npm, run `npm install -g @vigent/cli@latest`.

### Start screen and which-key

Like LazyVim, vigent opens on a dashboard. Press `i` and type a task, `n` to name a new agent, `t` for themes, `s` for settings, `m` / `e` for model and effort, `c` to check engines, `?` for every key, or `q` to quit. Press `Space` (the leader) and pause, and a which-key panel lists every key that can follow and what it does. `Esc` closes it, and `:set nowhichkey` turns it off.

![the dashboard, with the lazyvim theme over a translucent terminal](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/dashboard-lazyvim.png)

![which-key after Space](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/which-key.png)

### First agent

Inside a git repository, press `i`, type what you want done, and press Enter. An agent starts on it in its own worktree, using pi if it has an API key, or else the first signed-in CLI (Claude Code, Codex, OpenCode; `:checkhealth` shows which). Watch it work, press `i` again to follow up, and `Esc` to go back to NORMAL mode. `:new <task> --engine codex` starts more agents, and `]s` / `[s` or `1`–`9` switch between them.

## From source

```bash
git clone https://github.com/farming-labs/vigent && cd vigent
npm install
npm run build
npm run demo      # scripted sessions, no API key needed
npm test          # build and run the test suite
```

### Releasing

Bump `version` in package.json, merge, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`), or run the **Release** workflow from the Actions tab. It tests and publishes to npm with the `NPM_TOKEN` repository secret, and skips a version that's already published.

## Keys

| Mode | Key | Action |
|---|---|---|
| NORMAL | `i` / `a` / `o` | Enter INSERT and type a prompt for the focused agent (it waits in a queue if the agent is busy). With no agent yet, the prompt starts one |
| NORMAL | `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` `{` `}` | Scroll the transcript, or jump between messages |
| NORMAL | `]s` `[s` `1`–`9` `Ctrl-^` | Switch agents |
| NORMAL | `za` `zR` `zM` | Toggle, open or close tool-output folds |
| NORMAL | `/pattern` `?pattern` `n` `N` | Search the transcript, forward or backward |
| NORMAL | `V` / `v` | VISUAL: select lines with `j` `k`, `ib` for a code block, `y` to copy |
| NORMAL | `yy` / `yib` | Copy the agent's last reply / the nearest code block |
| NORMAL | `dd` | Kill the focused agent (asks first) |
| NORMAL | `<Space>n` `d` `m` `p` `q` `t` `D` `u` `s` | `:new`, `:diff`, `:merge`, `:pr`, `:queue`, colorscheme, `:dash`, `:tree`, `:settings` |
| INSERT | `Enter` / `Esc` | Send the prompt / back to NORMAL |

Copies go to the system clipboard through the terminal (OSC 52), so they work over SSH too. `:help` lists every active key, including yours.

![Neovim-style intro screen](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/intro.png)

![VISUAL mode on a markdown reply](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/visual-mode.png)

## Engines: pi, Claude Code, Codex, OpenCode

pi runs inside vigent. Claude Code, Codex and OpenCode are the CLIs you may already use: vigent runs them as installed, in the agent's worktree, so each one uses its own login and settings. vigent never reads their credentials; it only runs their version and sign-in status commands to show what's connected.

```vim
:new fix the race --engine codex            " this agent runs Codex
:new docs pass --engine claude --model opus " a model for that CLI
:checkhealth                                " installed? signed in? how to connect the rest
```

The sidebar's ENGINES block shows each one: `●` signed in, `◐` installed but not signed in (with the command to sign in, like `codex login`), `○` not installed. Without `--engine`, new agents use `engine` from the config. Its default, `"auto"`, picks pi if it has an API key, otherwise the first signed-in CLI. A CLI agent survives a restart too: vigent saves the CLI's conversation id and continues that conversation. Its earlier messages stay in the CLI's own history.

![:checkhealth with Claude Code signed in and Codex waiting for codex login](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/checkhealth.png)

![a Claude Code agent reopened after a restart, continuing its conversation](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/claude-code-agent.png)

| Engine | vigent runs | Default extra arguments |
|---|---|---|
| `claude` | `claude -p --output-format stream-json` | `--permission-mode acceptEdits` |
| `codex` | `codex exec --json` (`exec resume` to continue) | `-c sandbox_mode="workspace-write"` |
| `opencode` | `opencode run --format json --dir <worktree>` | none |

**Model and effort:** `:model` (`<Space>M`) opens a picker with the models the agent's engine offers (Claude Code's model names, Codex's own catalog from `codex debug models`, OpenCode's `opencode models`, or pi's for the providers you have a key for). In the picker, `j`/`k` move, `g`/`G` jump to the top or bottom, Enter picks and `q` or Esc closes. Press `/` to search, or to type any model name. `:effort` (`<Space>e`) sets the reasoning effort (pi: thinking level). Both apply from the next prompt, show in the winbar and survive a restart. With no agent open, they set the defaults for new agents.

![:model on a Claude Code agent](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/model-picker.png)

Change the arguments or the model per engine in `[engines.<id>]` ([docs/config.md](https://github.com/farming-labs/vigent/blob/main/docs/config.md#engines)).

## Worktrees

Every agent gets its own git worktree and branch, so agents never touch your checkout or each other's files:

```vim
:new fix flaky checkout test     " branch fix/flaky-checkout-test in ../<repo>-worktrees/fix-flaky-checkout-test
:new auth-refactor               " branch refactor/auth
:diff                            " what the focused agent changed, new files included
:worktrees                       " list them
:kill                            " stop the agent, keep its work  (:kill! also removes the worktree, safely)
```

Branch names follow the usual conventions (`fix/…`, `feat/…`, `docs/…`, `refactor/…`) and are taken from the task you type. The sidebar and statusline show each agent's branch with live `+added −removed` counts. Removing a worktree goes through git's own safety checks, so uncommitted or unmerged work is never thrown away. Folder, branch pattern and base branch are set in `[worktree]` ([docs/config.md](https://github.com/farming-labs/vigent/blob/main/docs/config.md#worktree)).

### Lightweight worktrees with riftri

A worktree is normally a full copy of your checkout, so ten agents on a big repo cost ten checkouts of disk. vigent installs [riftri](https://riftri.dev) with it (an optional dependency; `riftri` on your PATH works too). When riftri can, it makes each agent's worktree a real git linked worktree whose unchanged files share copy-on-write storage. Each new agent then costs almost no disk, and only the files it changes take space of their own. riftri uses APFS clones on macOS, Btrfs or reflink-enabled XFS (or OverlayFS) on Linux, and ReFS block clones on Windows.

- `:new` says `· riftri reflink` (or `apfs-clone`, `overlay-fs`, …) when riftri made the worktree. When it falls back to a plain git copy, it says so, and `:checkhealth` shows riftri's reason and its fix.
- `:checkhealth` and `:worktrees` show what the worktrees cost: for example, *4 worktrees: 58.0 MB of files in 11.7 MB on disk*.
- Removing (`:kill!`, `:worktree remove`) goes through `riftri worktree remove`, which refuses uncommitted changes like git does and journals the removal. After that, `riftri gc` frees storage that no agent uses any more.
- On restart, vigent inspects riftri's worktrees before reopening their agents. If an OverlayFS view lost its mount (after a reboot), vigent repairs it first.
- vigent falls back to git only when riftri declines with a receipt saying nothing was changed (unsupported volume, checkout or environment). Any other riftri failure is shown, never papered over. `[worktree] backend = "riftri"` requires riftri, and `"git"` turns it off.

![:worktrees with every agent on riftri](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/riftri-worktrees.png)

![agents in their own worktrees](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/worktrees-sidebar.png)

![:diff](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/worktrees-diff.png)

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
:diff split            " side by side; s switches layouts inside the diff window
:attach <branch>       " reopen an agent in a kept worktree (see :worktrees)
:tree                  " the conversation's branches: go back to any point and try again
```

`:tree` (or `<Space>u`) shows the focused agent's whole conversation, including branches you left. Pick an earlier prompt to edit it and send it again as a new branch, or pick a reply to continue from there. Every branch is kept in pi's session file, so it's still there after a restart.

Agents survive a restart: quit vigent, start it again in the same repo, and the agents you didn't `:kill` come back with their conversations. Their records live in git's own worktree metadata (`.git/worktrees/<name>/vigent/`), not in your files, and are deleted along with the worktree.

`:merge` and `:pr` first commit anything the agent left uncommitted. `:merge` only touches your checkout when it's on the agent's base branch with no uncommitted changes, and a conflict is rolled back so nothing changes. After a merge, `:kill!` removes the worktree and the merged branch. `:q` won't quit while agents are running; `:q!` or `ZQ` does. Use `:new <task> --model <id>` to give one agent a different model.

![:diff split](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/diff-split.png)

![:tree](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/tree.png)

![:merge](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/merge.png)

![:dash](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/dashboard.png)

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

You can also change keys while vigent runs, with `:nmap`, `:imap`, `:cmap`, `:unmap` and `:let mapleader`. **[docs/config.md](https://github.com/farming-labs/vigent/blob/main/docs/config.md)** has every option, action and built-in key.

![:help lists every key, yours first](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/keys-help.png)

## Themes

vigent speaks Neovim's highlight groups (`Normal`, `StatusLine`, `CursorLine`, …), so your vim or Neovim theme carries straight over.

```bash
vigent theme import                 # whatever colorscheme your nvim/vim config uses
vigent theme import kanagawa        # any colorscheme your editor can load (plugins included)
vigent theme import ./molokai.vim   # a .vim file, no editor needed
vigent theme new mine --from nord   # start your own theme, pre-filled with nord's colors
vigent --theme lazyvim              # LazyVim's look, on your terminal's own (transparent) background
vigent --theme nvim                 # follow your Neovim: the colorscheme your config sets
```

**Follow your editor:** with `theme = "nvim"` (or `"vim"`) in config.toml, vigent uses whatever colorscheme your Neovim config and plugins set, whether that's AstroNvim's `astrodark`, LazyVim's `tokyonight` or anything else. Change it in Neovim, and vigent picks it up the next time it starts. vigent keeps a copy (`themes/nvim.json`) so it opens instantly, and checks Neovim in the background.

Inside vigent, `:colorscheme` opens a picker with live preview. `:hi Group guifg=… guibg=…` changes any color on the spot, `:set transparent` lets your terminal's background (its blur, opacity or wallpaper) show through any theme, and `:theme save mine` keeps what's on screen as your own theme file. To keep settings, put them in `~/.config/vigent/config.toml` (`vigent config init` writes a starter file):

```toml
theme = "tokyonight"

[ui]
sidebar_width = 34
icons = "unicode"      # or "nerd" (Nerd Font icons), "ascii"
transparent = true     # the terminal's background, with any theme

[highlights]           # applied on top of any theme
Normal = { bg = "NONE" }
CursorLine = "guibg=#2a2f3a"
```

**Icons and fonts:** `icons = "nerd"` (or `:settings`, Icons) uses Nerd Font icons like AstroNvim and LazyVim: a git branch icon, status and engine icons, an icon per tool call (terminal, pencil, file, search…) and file-type icons in the diff view, colored from your theme. vigent draws in your terminal's font, the same as Neovim in a terminal, so for these icons set your terminal's font to a [Nerd Font](https://www.nerdfonts.com) (for example JetBrainsMono Nerd Font).

25 built in, including `lazyvim` (LazyVim's look, transparent), the tokyonight, catppuccin and rose-pine families, `dracula`, `onedark`, `everforest`, `nightfox`, `gruvbox`, `kanagawa`, `nord`, `monokai-pro`, `ayu-mirage`, and GitHub and solarized in dark and light. The picker shows each one's colors:

![the colorscheme picker: every theme with its colors, dark / light / transparent](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/colorscheme-swatches.png)

**`:settings`** (`<Space>s`) changes the theme, transparency, layout, engine, worktrees and any key in one place. Press `w` and it's saved to config.toml:

![:settings](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/settings.png)

![the lazyvim theme over a translucent terminal: sidebar, transcript and floats show the background through](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/lazyvim-transparent.png)

![colorscheme picker with live preview](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/colorscheme-picker.png)

![habamax imported from Neovim](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/imported-habamax.png)

![nord with :hi and :set changes applied live](https://raw.githubusercontent.com/farming-labs/vigent/main/docs/screenshots/live-customization.png)

The full guide covers importing, theme files, palettes, every option and every highlight group: **[docs/themes.md](https://github.com/farming-labs/vigent/blob/main/docs/themes.md)**.

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
  engines.ts         which engines are installed and signed in (:checkhealth)
  cli-engines.ts     Claude Code / Codex / OpenCode adapters and CliSession
  worktree.ts        a git worktree per agent: branch names, create, remove, diff
  riftri.ts          copy-on-write worktrees through riftri's JSON contract
  demo.ts            scripted demo sessions
test/                node:test suites (npm test)
```

See [DESIGN.md](https://github.com/farming-labs/vigent/blob/main/DESIGN.md) for the full plan and milestones.
