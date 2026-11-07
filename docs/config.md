# Configuration

vigent reads one file: `~/.config/vigent/config.toml` (or `$XDG_CONFIG_HOME/vigent/config.toml`). Everything in it is optional. Without the file, vigent uses Neovim's default look and the keys listed under [Built-in keys](#built-in-keys).

```bash
vigent config init     # write a commented starter file
vigent config check    # validate it: bad keys, unknown actions, missing themes
```

A mistake in the file never stops vigent from starting. It shows as a warning on the command line, and `vigent config check` lists every problem, with a suggestion when a name looks like a typo.

## A complete example

```toml
# ~/.config/vigent/config.toml

theme = "tokyonight"            # built-in, imported (vigent theme import), or your own
model = "claude-sonnet-4-5"     # model for new agents
leader = "<Space>"              # what <leader> means below (vim's default is "\")

[ui]
sidebar = true
sidebar_width = 32
number = true                   # session numbers in the sidebar
tilde = true                    # ~ on empty sidebar rows
icons = "unicode"               # or "ascii"
timeoutlen = 500                # ms to wait for the rest of a multi-key mapping

[highlights]                    # on top of whichever theme is active
Normal = { bg = "NONE" }        # transparent background
Comment = "gui=NONE"            # no italic comments
CursorLine = "guibg=#2a2f3a"

[worktree]
enabled = true
dir = "../{repo}-worktrees"
branch = "{type}/{name}"        # "fix flaky test" -> fix/flaky-test

[keys.normal]
"<leader>n" = ":new "           # opens ":new " so you can type a name
"<leader>x" = ":kill<CR>"
"<leader>t" = "theme.picker"
"<leader>h" = "app.help"
"<leader>d" = ":colorscheme default<CR>"
"<Tab>" = "session.next"
"<S-Tab>" = "session.prev"
"J" = "scroll.half_down"
"K" = "scroll.half_up"
"<C-j>" = ["fold.open_all", "scroll.bottom"]
"H" = "gg"                      # H does what gg does
"q" = false                     # unbind a built-in key

[keys.insert]
"jk" = "<Esc>"
"<C-s>" = "edit.submit"

[keys.command]
"<C-k>" = "edit.clear"
```

## `:settings`: change it all without editing this file

`:settings` (or `<Space>s`) opens every option in one float, and changes apply immediately:

| Section | What you can change |
|---|---|
| Look | theme (Enter opens the picker), transparent background, icons, 24-bit color |
| Layout | sidebar, its width, session numbers, `~` rows |
| Agents | the engine for new agents, a worktree per agent, worktree storage (riftri or git) |
| Keys | the leader, and every NORMAL-mode key: Enter, type the new keys, Enter again |

Move with `j`/`k`, change with `Enter`/`Space` (or step with `h`/`l`), and press `w` to write the changes to this file. Saving changes only those values: a setting you had commented out is replaced in place, and your comments and other settings stay. A key you move is saved as the new mapping plus `false` for the old key.

## Top-level settings

| Key | Default | Meaning |
|---|---|---|
| `theme` | `"default"` | Colorscheme at startup. `colorscheme` is accepted as an alias. See [themes.md](themes.md). |
| `model` | `"claude-sonnet-4-5"` | Model for new pi agents. `--model` on the command line wins. |
| `engine` | `"auto"` | What runs new agents: `"pi"`, `"claude"`, `"codex"`, `"opencode"`, or `"auto"` (pi if it has an API key, else the first signed-in CLI). `--engine` on the command line wins; `:new <task> --engine <id>` picks one per agent. See [`[engines]`](#engines). |
| `leader` | `"<Space>"` | The key `<leader>` stands for in `[keys]`, like vim's `mapleader` (vim's own default is `"\"`). `mapleader` is accepted as an alias. |

## `[ui]`

Each option can also be changed while vigent runs, with vim's `:set` syntax: `:set nonumber`, `:set number!`, `:set sidebar_width=40`, `:set tm=300`. `:set` alone lists them all.

| Option | Default | Meaning |
|---|---|---|
| `sidebar` | `true` | show the session sidebar (hidden anyway on narrow terminals) |
| `sidebar_width` | `30` | sidebar width in columns, 16–80 |
| `number` | `true` | session numbers in the sidebar (they match the `1`–`9` keys) |
| `tilde` | `true` | `~` on empty sidebar rows |
| `icons` | `"unicode"` | `"ascii"` swaps every glyph for plain ASCII |
| `timeoutlen` | `1000` | ms to wait for the next key of a mapping (vim's `'timeoutlen'`, alias `tm`) |
| `termguicolors` | `true` (`false` in macOS Terminal.app) | 24-bit color, as in vim. Turn it off on terminals without it, and every color is mapped to the nearest of the 256 standard ones (alias `tgc`) |
| `transparent` | `"auto"` | draw on the terminal's own background, so its blur, opacity or wallpaper shows through. `"auto"` does what the theme says (`lazyvim` is transparent); `true` or `false` forces it for every theme. Live: `:set transparent`, `:set notransparent`, `:set transparent!`, and `:set transparent&` back to `"auto"` |

## `[highlights]`

Overrides for any highlight group, applied on top of whichever theme is active, including after `:colorscheme`. A value can be a table, a vim `:hi` string, or the name of a group to link to:

```toml
[highlights]
Normal = { fg = "#c0caf5", bg = "NONE", bold = false }
Comment = "guifg=#565f89 gui=italic"
VigentSidebar = "NormalFloat"
```

The full list of groups, and how to write whole themes, is in [themes.md](themes.md).

## `[worktree]`

Each agent works in its own git worktree, on its own branch, so agents never touch your checkout or each other's files. `:new fix flaky checkout test` creates the branch `fix/flaky-checkout-test` from the branch you have checked out, in `../<repo>-worktrees/fix-flaky-checkout-test`, and starts the agent there.

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | give each new agent a worktree (`:new!` skips it for one agent) |
| `dir` | `"../{repo}-worktrees"` | where worktrees go, relative to the repo root; `{repo}` is the repo's folder name. A folder inside the repo is added to `.git/info/exclude` so `git status` stays clean |
| `branch` | `"{type}/{name}"` | branch name pattern; must contain `{name}` |
| `base` | the checked-out branch | branch to start new worktrees from |
| `backend` | `"auto"` | how worktrees are made. `"auto"`: with [riftri](https://riftri.dev) when it's installed and can make copy-on-write worktrees here, else plain `git worktree`. `"riftri"`: always riftri (an error if it can't). `"git"`: never riftri |

**riftri** (installed with vigent as an optional dependency, or found on your PATH, or set with `$RIFTRI_BINARY`) makes each agent's worktree a real git linked worktree whose unchanged files share copy-on-write storage with the others. It uses APFS clones, Btrfs/XFS reflinks, OverlayFS or ReFS block clones. With `"auto"`, vigent falls back to git only when riftri declines with a receipt saying nothing was changed. Any other riftri failure stops `:new` with riftri's message and its suggested command. `:checkhealth` shows whether riftri is ready for your worktrees folder, what's blocking it, and how much disk the worktrees use. riftri refuses to run while `GIT_CONFIG_PARAMETERS`, or a `GIT_CONFIG_COUNT` with anything beyond network settings (`credential.*`, `http.*`, `url.<base>.insteadOf`), is set, because those inject git config into its internal git commands. Hosted agent sandboxes, which set only network settings, work from riftri 0.6.7. `:checkhealth` reports the reason when riftri declines.

**Branch names** are built from the task you type:

| You type | Branch |
|---|---|
| `fix flaky checkout test` | `fix/flaky-checkout-test` |
| `auth-refactor` | `refactor/auth` |
| `docs: refresh README flags` | `docs/refresh-readme-flags` |
| `add dark mode` | `feat/add-dark-mode` |
| `release/v2 notes` | `release/v2-notes` (a name with `/` is used as written) |

A first or last word of `feat`, `fix` (also `bugfix`, `hotfix`, `bug`), `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build` or `style` becomes the type. Otherwise the type is `feat`. Names are lowercase ASCII with hyphens, at most 48 characters. Reusing a name gives `-2`, `-3`, … instead of failing. Other patterns: `"agent/{name}"`, or `"yourname/{type}/{name}"`.

**Removing** always goes through git's safety checks. `git worktree remove` (or `riftri worktree remove` for riftri's worktrees, followed by `riftri gc` to free unused storage) refuses a worktree with uncommitted changes, and the branch is deleted only if it's merged. Otherwise it's kept, so finished work is never lost by accident:

```vim
:kill                       " stop the agent, keep its worktree and branch
:kill!                      " stop it and remove the worktree (refused if it has uncommitted changes)
:worktree remove <branch>   " remove a worktree no agent is using (:worktree remove! forces it)
:worktrees                  " list them; ● marks the ones an agent is working in
:diff                       " everything the focused agent changed, new files included (]c / [c between hunks)
:diff split                 " side by side (s switches layouts in the diff window)
:attach <branch>            " reopen an agent in a worktree that's kept (after :kill, or made elsewhere)
:merge                      " squash-merge the agent's branch into its base, in your checkout
:merge --no-squash          " a regular merge commit instead
:pr                         " push the branch and open a pull request
```

**Restarting:** vigent saves each agent's name, model and conversation inside git's own record of its worktree (`.git/worktrees/<name>/vigent/`). riftri worktrees are inspected first, and an OverlayFS view that lost its mount in a reboot is repaired before its agent reopens. When you start vigent again in the repo, every agent you didn't `:kill` comes back where it left off. `:kill` keeps the worktree but doesn't reopen it; `:attach <branch>` does. Removing the worktree removes the record too.

`:merge` and `:pr` first commit anything the agent left uncommitted, using a message built from the branch (`fix/flaky-checkout-test` → `fix: flaky checkout test`). `:merge` only runs when your checkout is on the base branch with no uncommitted changes, and a conflict is rolled back so your checkout is left as it was. A squash merge makes a new commit, so git doesn't count the branch as merged. vigent checks the content instead, so `:kill!` afterwards deletes the branch too. `:pr` uses `gh` when it's installed and signed in; otherwise it pushes and prints the GitHub compare URL.

From the shell: `vigent worktree list` (with each worktree's backend), `vigent worktree remove <branch> [--force]`, `vigent worktree prune`, `vigent worktree gc` (free riftri storage that no worktree uses).

## `[engines]`

Claude Code, Codex and OpenCode run as installed, each with its own login; vigent never reads their credentials. `:checkhealth` (or `:engines`) shows which are installed and signed in, and the command to connect the rest. One table per CLI:

```toml
[engines.claude]
args = ["--permission-mode", "acceptEdits"]   # the default
model = "opus"                                # default: Claude Code's own

[engines.codex]
args = ["-c", 'sandbox_mode="workspace-write"']  # the default
# model = "gpt-5"

[engines.opencode]
model = "anthropic/claude-sonnet-4-5"         # provider/model
```

| Option | Meaning |
|---|---|
| `args` | Extra arguments for every run of that CLI. They **replace** the defaults above, so keep a permission or sandbox setting in them. vigent always adds its own JSON-output and resume flags, and the prompt last. |
| `model` | Model for new agents on that engine. Without it, the CLI uses its own default. `:new <task> --engine claude --model sonnet` overrides it for one agent. |

`claude -p` can't stop and ask before a tool runs, so with the default `acceptEdits` Claude Code may edit files in the worktree, and other tools follow the permission rules in your Claude Code settings. Use `"--permission-mode", "bypassPermissions"` only where the agent is sandboxed.

## `[keys]`

One table per mode: `[keys.normal]`, `[keys.insert]`, `[keys.visual]` and `[keys.command]` (the `:`, `/` and `?` command line). Entries placed directly under `[keys]` count as normal mode.

Each entry maps a key sequence (left) to what it does (right). Your mappings replace built-in ones with the same keys and leave every other built-in key alone.

### Writing keys

Keys use vim's notation, so mappings can be copied from a vimrc:

| Write | Key |
|---|---|
| `j`, `G`, `]s`, `gg` | the characters themselves; sequences are typed in order |
| `<C-d>` | Ctrl-d (case doesn't matter: `<c-D>` is the same) |
| `<M-x>` or `<A-x>` | Alt-x |
| `<S-Tab>`, `<C-S-p>` | with Shift (`<S-a>` is just `A`) |
| `<CR>` `<Esc>` `<Tab>` `<BS>` `<Space>` `<Del>` | Enter, Escape, Tab, Backspace, Space, Delete |
| `<Up>` `<Down>` `<Left>` `<Right>` `<Home>` `<End>` `<PageUp>` `<PageDown>` | movement keys |
| `<F1>` … `<F12>` | function keys |
| `<leader>` | the `leader` setting |
| `<lt>`, `<Bar>`, `<Bslash>` | `<`, `\|`, `\` |

### What a key can do

| Right-hand side | Example | Effect |
|---|---|---|
| an action | `"session.next"`, `"session.goto 3"` | runs a built-in action (list below) |
| an ex command ending in `<CR>` | `":colorscheme nord<CR>"` | runs the command |
| an ex command without `<CR>` | `":new "` | opens the command line with that text, so you can finish typing |
| `<Cmd>…<CR>` | `"<Cmd>kill<CR>"` | runs the command (Neovim style) |
| other keys | `"gg"`, `"<Esc>"`, `"ihello"` | presses those keys with their **built-in** meaning |
| a list | `["fold.open_all", "G"]` | each in order |
| `false` or `"<Nop>"` | `q = false` | the key does nothing |

When the right-hand side is other keys, they always get their built-in meaning, the way vim's `noremap` works. That makes swaps like `j = "k"` and `k = "j"` safe: neither one loops back to your own mappings.

### Multi-key mappings and `timeoutlen`

When a key could start a longer mapping, vigent waits `timeoutlen` ms for the next one, exactly as vim does. What you've typed so far shows near the bottom right, like vim's `showcmd`.
- `jk` in insert mode: typing `j` waits briefly. `k` finishes the mapping. Any other key, or the timeout, types the `j` normally.
- If you map both `g` and the built-in `gg` exists, `gg` still works. A lone `g` fires after the timeout, or as soon as you press a key that isn't `g`.

Pasted text always goes in as text, never as keys, so pasting `jk` into a prompt doesn't leave insert mode.

### Changing keys while vigent runs

The same mappings work as commands, with vim's names:

```vim
:nmap <leader>t theme.picker        " normal mode (also :map, :noremap, :nnoremap)
:imap jk <Esc>                       " insert mode (also :inoremap)
:xmap Y visual.yank                  " VISUAL mode (also :vmap, :xnoremap)
:cmap <C-k> edit.clear               " command line (also :cnoremap)
:nunmap q                            " remove a mapping (:unmap, :iunmap, :cunmap)
:nmap J                              " show what J does
:map                                 " list your mappings
:let mapleader = ","                 " change the leader for mappings made after this
:help                                " every active key, yours marked with *
```

Like vim, every mapping is non-recursive, so `:nmap` behaves like `:nnoremap`. Changes made with these commands last until you quit. Put them in `config.toml` to keep them.

### Actions

| Action | Does |
|---|---|
| `mode.normal` | back to NORMAL mode |
| `mode.insert` | write a prompt to the focused agent (INSERT) |
| `mode.command` | open the `:` command line |
| `mode.search` | search the transcript |
| `mode.search_back` | search the transcript backward (`n` then goes up) |
| `mode.visual` | select transcript lines (VISUAL LINE mode) |
| `cursor.down`, `cursor.up` | move the VISUAL cursor one line |
| `cursor.half_down`, `cursor.half_up` | move the VISUAL cursor half a page |
| `cursor.top`, `cursor.bottom` | move the VISUAL cursor to the top / bottom |
| `visual.yank` | copy the selected lines to the clipboard |
| `visual.inner_block` | select the code block under the VISUAL cursor |
| `visual.swap` | jump to the other end of the selection |
| `message.next`, `message.prev` | jump to the next / previous message |
| `yank.reply` | copy the agent's last reply |
| `yank.block` | copy the code block nearest the bottom of the screen |
| `scroll.down`, `scroll.up` | scroll one line |
| `scroll.half_down`, `scroll.half_up` | scroll half a page |
| `scroll.page_down`, `scroll.page_up` | scroll a page |
| `scroll.top`, `scroll.bottom` | jump to the top / bottom of the transcript |
| `session.next`, `session.prev` | next / previous session |
| `session.alternate` | the session you were on before |
| `session.goto N` | session N, e.g. `"session.goto 3"` |
| `session.new` | spawn a new agent |
| `session.kill` | kill the focused agent, after asking (`:kill` doesn't ask) |
| `session.abort` | stop the focused agent's current run |
| `session.pause` | stop the run and hold queued prompts (`:pause`) |
| `session.resume` | continue a paused agent (`:resume`) |
| `session.tree` | the conversation tree: go back to an earlier point and branch (`:tree`) |
| `fold.toggle` | fold / unfold tool output |
| `fold.open_all`, `fold.close_all` | unfold / fold all tool output |
| `search.next`, `search.prev` | next / previous match |
| `search.clear` | clear search highlighting |
| `edit.submit` | send the prompt, or run the command line |
| `edit.backspace` | delete the character before the cursor |
| `edit.delete_word` | delete the word before the cursor |
| `edit.clear` | clear the prompt or command line |
| `theme.picker` | pick a colorscheme (live preview) |
| `app.help` | show every key |
| `app.dashboard` | all agents at a glance (`:dash`) |
| `app.redraw` | redraw the screen |
| `app.quit` | quit vigent; refuses while agents are running, like vim's `:q` |
| `app.quit_force` | quit even with agents running (`:q!`) |
| `app.quit_hint` | explain how to quit |
| `noop` | do nothing |

### Built-in keys

**Normal mode**

| Keys | Action |
|---|---|
| `i` `a` `o` | `mode.insert` |
| `:` | `mode.command` |
| `/` / `?` | `mode.search` / `mode.search_back` |
| `v` `V` | `mode.visual` |
| `j` `<Down>` / `k` `<Up>` | `scroll.down` / `scroll.up` |
| `<C-d>` / `<C-u>` | `scroll.half_down` / `scroll.half_up` |
| `<C-f>` `<PageDown>` / `<C-b>` `<PageUp>` | `scroll.page_down` / `scroll.page_up` |
| `gg` / `G` | `scroll.top` / `scroll.bottom` |
| `]s` / `[s` | `session.next` / `session.prev` |
| `<C-^>` | `session.alternate` |
| `1` … `9` | `session.goto 1` … `session.goto 9` |
| `za` / `zR` / `zM` | `fold.toggle` / `fold.open_all` / `fold.close_all` |
| `n` / `N` | `search.next` / `search.prev` |
| `{` / `}` | `message.prev` / `message.next` |
| `yy` / `yib` | `yank.reply` / `yank.block` |
| `dd` | `session.kill` (asks first) |
| `<Esc>` | `search.clear` |
| `<C-c>` | `session.abort` |
| `<C-l>` | `app.redraw` |
| `ZZ` / `ZQ` | `app.quit` / `app.quit_force` |
| `q` | `app.quit_hint` |
| `<leader>n` | `:new ` (type the task) |
| `<leader>d` | `:diff` |
| `<leader>m` | `:merge` |
| `<leader>p` | `:pr` |
| `<leader>q` | `:queue ` (type a follow-up) |
| `<leader>t` | `theme.picker` |
| `<leader>D` | `:dash` |
| `<leader>u` | `session.tree` (like an undo tree, for the conversation) |
| `<leader>s` | `:settings<CR>` (theme, look, engine, worktrees and keys in one float) |

**VISUAL mode** (`v` or `V`: whole lines, like vim's `V`)

| Keys | Action |
|---|---|
| `j` `<Down>` / `k` `<Up>` | `cursor.down` / `cursor.up` |
| `<C-d>` / `<C-u>` | `cursor.half_down` / `cursor.half_up` |
| `gg` / `G` | `cursor.top` / `cursor.bottom` |
| `y` | `visual.yank` |
| `ib` | `visual.inner_block` |
| `o` | `visual.swap` |
| `<Esc>` `<C-c>` `v` `V` | `mode.normal` |

**Insert mode and the command line**

| Keys | Action |
|---|---|
| `<Esc>` `<C-c>` | `mode.normal` (in INSERT, the prompt you were typing is kept) |
| `<CR>` | `edit.submit` |
| `<BS>` `<C-h>` | `edit.backspace` (on an empty command line, leaves it) |
| `<C-w>` | `edit.delete_word` |
| `<C-u>` | `edit.clear` |
