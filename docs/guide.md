# Using vigent

The README is the short version. This is everything else about using vigent day to day. Every option and key is in [config.md](config.md), and themes are in [themes.md](themes.md).

- [Getting around](#getting-around)
- [Engines](#engines)
- [Worktrees](#worktrees)
- [Reviewing and landing work](#reviewing-and-landing-work)
- [While several agents run](#while-several-agents-run)
- [From your phone](#from-your-phone)
- [Keys](#keys)

## Getting around

### Start screen and which-key

Like LazyVim, vigent opens on a dashboard. Press `i` and type a task, `n` to name a new agent, `t` for themes, `s` for settings, `m` / `e` for model and effort, `c` to check engines, `?` for every key, or `q` to quit. Press `Space` (the leader) and pause, and a which-key panel lists every key that can follow and what it does. `Esc` closes it, and `:set nowhichkey` turns it off.

### First agent

Inside a git repository, press `i`, type what you want done, and press Enter. An agent starts on it in its own worktree, using the first CLI you're signed in to (Claude Code, Codex, OpenCode, Gemini CLI, Cursor CLI), with its own login and settings, or else pi if it has a key (`:checkhealth` shows which). Watch it work, press `i` again to follow up, and `Esc` to go back to NORMAL mode. `:new <task> --engine codex` starts more agents, and `]s` / `[s` or `1`–`9` switch between them.

### Pointing an agent at files

Type `@` in a prompt and a file picker opens over it with the files in the agent's worktree (what git tracks plus new files, never what `.gitignore` hides). Type to narrow it, `Enter` writes `@src/cart.js`, `Esc` keeps a plain `@`, and `Backspace` takes the `@` back. Each engine gets the files its own way: Claude Code reads `@path` itself, OpenCode gets them with `-f`, and for Codex and pi vigent adds each file's contents under your prompt (text files up to 100 KB; the transcript notes any it left out). The transcript shows what you typed, with the mentions highlighted.

### Templates

For prompts you use often, `:new -t fix the cart total is off by one` starts an agent and sends it the `fix` template with your task filled in. Four are built in: `fix` (failing test first, then the fix), `test`, `review` (changes nothing) and `explain`. `:templates` (`Space T`, or `T` on the start screen) picks one. Add your own under `[templates.<name>]` in config.toml, each with an optional engine, model and effort ([docs/config.md](config.md#templates)).

## Engines

Each engine is a harness you install yourself: a program that runs the whole agent loop, from calling its model to running its tools (bash, edit, search…) and managing its context, retries and permissions. vigent runs it as installed, in the agent's worktree, so each one uses its own login and settings. vigent is the orchestrator around them: it starts them, reads what they stream, and handles queues, permissions, restarts, review and merge. vigent never reads their credentials; it only runs their version and sign-in status commands to show what's connected. If `ANTHROPIC_API_KEY` is set and Claude Code is also signed in with a Claude account, vigent runs Claude Code without that variable, so it uses your account (a key that isn't scoped to a workspace, or is out of credit, would otherwise fail every request). `:checkhealth` says so: *signed in (Claude account; ANTHROPIC_API_KEY left out)*.

```vim
:new fix the race --engine codex            " this agent runs Codex
:new docs pass --engine claude --model opus " a model for that CLI
:checkhealth                                " installed? signed in? how to connect the rest
```

The sidebar's ENGINES block shows each one: `●` signed in, `◐` installed but not signed in (with the command to sign in, like `codex login`), `○` not installed. Without `--engine`, new agents use `engine` from the config. Its default, `"auto"`, picks the first signed-in CLI, otherwise pi if it has an API key. With neither, vigent starts nothing and says what to run (`claude auth login`, `codex login`) or export (`ANTHROPIC_API_KEY`) to connect one. **`:engine`** (`<Space>E`, or `E` on the dashboard) switches it while vigent runs: a menu lists auto and every engine, with which are ready, and `:engine claude` sets it directly. Agents already open keep their engine, since their conversation lives there; `:new <task>` starts one on the new engine. A CLI agent survives a restart too: vigent saves the CLI's conversation id and continues that conversation. Its earlier messages stay in the CLI's own history.

| Engine | vigent runs | Default extra arguments |
|---|---|---|
| `claude` | `claude -p --output-format stream-json` | `--permission-mode acceptEdits` |
| `codex` | `codex exec --json` (`exec resume` to continue) | `-c sandbox_mode="workspace-write"` |
| `opencode` | `opencode run --format json --dir <worktree>` | none |
| `gemini` | `gemini --output-format stream-json --prompt …` (`--resume <session>` to continue) | `--approval-mode auto_edit` |
| `cursor` | `cursor-agent --print --output-format stream-json …` (`--resume <chat>` to continue) | `--force` (the agent works in its own worktree) |
| `pi` | `pi --mode rpc` (one per agent, kept running) | none |

Anything else that takes a prompt (Amp, Copilot CLI, Aider, Goose, Qwen Code…) is a few lines of config; [docs/config.md](config.md#your-own-engines) has them ready to copy.

**Model and effort:** `:model` (`<Space>M`) opens one plain list of every model by name and version (`Claude Fable 5.1`, `Claude Opus 5.5`, `GPT-5.5 Codex`…) with its id beside it, from every engine that's signed in (Codex's catalog comes from `codex debug models`, OpenCode's from `opencode models`, pi's from `pi --list-models`). An open agent keeps its engine, so a model from another engine is used for new agents. In the picker, `j`/`k` move, `g`/`G` jump to the top or bottom, Enter picks and `q` or Esc closes. Press `/` to search, or to type any model name. `:effort` (`<Space>R`) sets the reasoning effort (pi: thinking level). Both apply from the next prompt, show in the winbar and survive a restart. With no agent open, they set the defaults for new agents.

Change the arguments or the model per engine in `[engines.<id>]` ([docs/config.md](config.md#engines)).

**Your own engines:** any other agent CLI that takes a prompt can be an engine too. Give it a table with a `command` (`{prompt}` is where the prompt goes) and it shows up in the sidebar, `:engine`, `:model` and `--engine` like the rest. By default what it prints is the reply; a CLI that prints Claude Code's, Codex's or OpenCode's JSON gets tool calls and costs as well ([details](config.md#your-own-engines)):

```toml
[engines.aider]
name = "Aider"
command = ["aider", "--yes-always", "--message", "{prompt}"]
model_args = ["--model", "{model}"]
```

**Permissions:** agents run headless, so one can't stop to ask before a command it isn't allowed; it refuses it (for example `gh`, `git fetch` or a web fetch under Claude Code's `acceptEdits`). vigent shows what was refused and the `:permissions allow …` line that would permit it.

**`:permissions`** opens a panel of what each agent may do without asking, changed in place:

| Agent | What you can toggle |
|---|---|
| Claude Code | its mode (`acceptEdits`, `default`, `plan`, `bypassPermissions`), asking when it's refused a tool (allow once / always / no), and allow rules for `gh`, `git`, `npm`, web fetch and web search |
| Codex | its sandbox (`read-only`, `workspace-write`, `danger-full-access`) and network access (off by default in `workspace-write`) |
| Gemini CLI | its approval mode (`default`, `auto_edit`, `yolo`) |
| Cursor CLI | running commands without asking (`--force`) |

Each change is saved to config.toml as you make it, so it stays set after a restart, and applies from each agent's next prompt, agents already open included. With several vigents open, each change (and each "always allow") starts from what's saved, so one vigent never undoes another's. `:permissions allow Bash(cargo:*)` adds any other Claude Code rule (several at once work too), and `:permissions remove <rule>` takes one away. It's also a row in `:settings`. The same settings live in `[engines.<id>]` ([details](config.md#when-claude-code-is-refused-a-tool)).

### pi: extensions, skills and prompt templates

Install pi with `npm install -g @mariozechner/pi-coding-agent` (and give it a key, or log in with pi's `/login`). vigent keeps one `pi --mode rpc` running per agent, in its worktree, and talks to it over stdin and stdout: prompts go in, pi's events come out, and the conversation is saved in pi's session file in the worktree, so the agent survives a restart. A pi agent loads what pi itself would load. That covers extensions from `~/.pi/agent/extensions/` and `.pi/extensions/`, and the packages you installed with pi. It also covers skills, prompt templates, and the project's `AGENTS.md`.

vigent gives extensions a UI of their own. When an extension asks for confirmation, vigent shows a y/n question in the command line. Choices and text input open pickers. Notifications go to the transcript and the message line, and statuses show in the winbar. Each one names the agent it came from, and a question from an agent you aren't looking at rings the bell. So pi's permission gate works the same as in pi: it asks before an `rm -rf`, and **No** blocks the command.

Type an extension's command (`/deploy`), a skill (`/skill:changelog`) or a prompt template (`/tidy src/cart.js`) as a prompt. **`:pi`** lists everything the focused agent loaded. Press Enter on a command, skill or prompt template to start a prompt with it. An extension that doesn't load stops pi, as it does in pi itself; the agent's transcript says which one and why.

## Worktrees

Every agent gets its own git worktree and branch, so agents never touch your checkout or each other's files:

```vim
:new fix flaky checkout test     " branch fix/flaky-checkout-test in ../<repo>-worktrees/fix-flaky-checkout-test
:new auth-refactor               " branch refactor/auth
:diff                            " what the focused agent changed, new files included
:worktrees                       " list them
:kill                            " stop the agent, keep its work  (:kill! also removes the worktree, safely)
```

Branch names follow the usual conventions (`fix/…`, `feat/…`, `docs/…`, `refactor/…`) and are taken from the task you type. The sidebar and statusline show each agent's branch with live `+added −removed` counts. Removing a worktree goes through git's own safety checks, so uncommitted or unmerged work is never thrown away. Folder, branch pattern and base branch are set in `[worktree]` ([docs/config.md](config.md#worktree)).

### Lightweight worktrees with riftri

A worktree is normally a full copy of your checkout, so ten agents on a big repo cost ten checkouts of disk. vigent installs [riftri](https://riftri.dev) with it and makes every worktree through it (`riftri` on your PATH works too). When riftri can, it makes each agent's worktree a real git linked worktree whose unchanged files share copy-on-write storage. Each new agent then costs almost no disk, and only the files it changes take space of their own. riftri uses APFS clones on macOS, Btrfs or reflink-enabled XFS (or OverlayFS) on Linux, and ReFS block clones on Windows.

- `:new` says `· riftri reflink` (or `apfs-clone`, `overlay-fs`, …) when riftri made the worktree. When it falls back to a plain git copy, it says so, and `:checkhealth` shows riftri's reason and its fix.
- `:checkhealth` and `:worktrees` show what the worktrees cost: for example, *4 worktrees: 58.0 MB of files in 11.7 MB on disk*.
- Removing (`:kill!`, `:worktree remove`) goes through `riftri worktree remove`, which refuses uncommitted changes like git does and journals the removal. After that, `riftri gc` frees storage that no agent uses any more.
- On restart, vigent inspects riftri's worktrees before reopening their agents. If an OverlayFS view lost its mount (after a reboot), vigent repairs it first.
- vigent falls back to git only when riftri declines with a receipt saying nothing was changed (unsupported volume, checkout or environment). Any other riftri failure is shown, never papered over. `[worktree] backend = "riftri"` requires riftri, and `"git"` turns it off.

## Reviewing and landing work

**`:review`** (`Space r`) goes through the agent's changes one hunk at a time. That covers its commits, its uncommitted edits and its new files. Press `x` to drop the hunk under the cursor, `X` to drop the whole file, and `u` to undo. Dropping takes the change out of the agent's worktree, so `:merge` and `:pr` land only what you kept.

```vim
:diff                  " the agent's changes; ]c / [c jump between hunks
:merge                 " squash-merge its branch into yours: one commit, e.g. "fix: flaky checkout test"
:merge --no-squash     " a regular merge commit instead
:pr                    " push the branch and open a pull request (gh), or print the compare URL
:dash                  " every agent at a glance; j/k and Enter to jump to one
:cost                  " tokens and money each agent has used, and the total
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

## While several agents run

When an agent finishes, fails or needs you while you're looking at another one (or at another window), vigent rings the bell. In iTerm2, WezTerm, Ghostty and kitty it also sends a desktop notification, inside tmux too. The message line says which agent and the key to open it, and the agent gets a ◆ in the sidebar until you do. Set `notify` in `[ui]` (or `:settings`) to `"bell"`, `"desktop"` or `"off"`.

The statusline shows what the agent on screen has used, like `74.8k tok · $0.50`, and `:dash` adds up every agent. `:cost` lists each agent with its engine, tokens and cost, and the total. Costs are what each engine reports: Claude Code prices what it used at API rates even on a subscription, OpenCode prices each step, pi uses its model prices, and Codex reports tokens only. CLI agents keep their totals across restarts.

## From your phone

**`:serve`** lets you follow your agents from your phone, or start `vigent --serve` to have it on from the beginning. vigent shows an address on your network and an 8-character access code. Open the address on your phone and type the code, or open the link that already has the code in it.

The page uses your theme's colors. It lists your agents with their state, branch, changes and cost, and follows a reply as it streams. You can send a follow-up (it waits its turn if the agent is busy), stop an agent, or start a new one.

The code is new each time, and every request needs it. Prompts and stops need it in a header, so no other web page can send them through your browser. After 10 wrong codes the server stops answering. It's plain HTTP, so use it on your own Wi-Fi or over a VPN like Tailscale, not on public Wi-Fi. `:serve local` listens on this machine only, for an SSH tunnel. `:serve 9000` picks the port (the default is 8377). `:serve stop` ends it and retires the code.

## Keys

| Mode | Key | Action |
|---|---|---|
| NORMAL | `i` / `a` / `o` | Enter INSERT and type a prompt for the focused agent (it waits in a queue if the agent is busy). With no agent yet, the prompt starts one |
| NORMAL | `j` `k` `gg` `G` `Ctrl-d` `Ctrl-u` `{` `}` | Scroll the transcript, or jump between messages |
| NORMAL | `]s` `[s` `<Space>1`–`9` `gt` `Ctrl-^` | Switch agents; `3gt` goes to agent 3 |
| NORMAL, VISUAL | `5j` `3<C-d>` `2n` `40G` `4<C-w>>` | A count before a key, like vim: it repeats scrolling, cursor moves, message and search jumps, agent switches and resizes. `{N}G` and `{N}gg` go to line N, `{N}<C-w>w` to window N |
| NORMAL | `<Space>e` | Move the cursor into the SESSIONS sidebar, like neo-tree: `j`/`k` (or `gg`/`G`, `1`–`9`) pick an agent and show it, `a` starts a new one, `dd` kills the one under the cursor (asks first), Enter / Esc / `l` / `<Space>e` go back to the transcript |
| NORMAL | `<C-w>v` `<C-w>s` | Split the window side by side or stacked. The new window forks the agent: same history, its own conversation from here, in the same folder (Claude Code and Codex; other engines say they can't). `:vsplit 2` or `:split <name>` shows another agent instead, and `]s` changes the agent in the current window. Each window's bar is a strip in the `CursorLine` color, so you can see where each one starts, and the current one's agent is in bold. A fork isn't reopened after a restart |
| NORMAL | `<C-w>h` `j` `k` `l` `<C-w>w` `<C-w>p` | Move between windows and the sidebar; `<C-h>` `<C-j>` `<C-k>` `<C-l>` work too, LazyVim-style (`<C-l>` still redraws when there's nothing to its right) |
| NORMAL | `<C-w>c` `<C-w>o` `<C-w>=` `<C-w>>` `<C-w><` `<C-w>+` `<C-w>-` `<C-w>\|` `<C-w>_` `<C-w>x` `<C-w>r` | Close, keep only this one, even out, resize, maximize, swap and rotate windows. `:q` closes a split before it quits; `:qa` quits from anywhere |
| NORMAL | `:bn` `:bp` `:b <agent>` `:ls` `:bd` `gt` `gT` | Agents work like buffers |
| NORMAL | `za` `zR` `zM` | Toggle, open or close tool-output folds |
| NORMAL | `/pattern` `?pattern` `n` `N` | Search the transcript like Neovim: it jumps to the first match as you type and highlights every match, `n`/`N` go to the next/previous one with `[3/7]` in the command line, `Esc` or `:noh` clears the highlight. Smartcase: a capital makes it case-sensitive |
| NORMAL | `V` / `v` | VISUAL: select lines with `j` `k`, `ib` for a code block, `y` to copy |
| NORMAL | `yy` / `yib` | Copy the agent's last reply / the nearest code block |
| NORMAL | `dd` | Kill the focused agent (asks first) |
| NORMAL | `<Space>n` `d` `m` `p` `q` `t` `D` `u` `s` | `:new`, `:diff`, `:merge`, `:pr`, `:queue`, colorscheme, `:dash`, `:tree`, `:settings` |
| INSERT | `Enter` / `Esc` | Send the prompt / back to NORMAL |
| INSERT, `:` | `<Left>` `<Right>` `<C-Left>` `<Home>` `<End>` `<Del>` | The prompt and the command line have a cursor; typing goes in where it is. `<C-w>` and `<C-u>` delete the word or everything before it |
| INSERT, `:` | `<Up>` `<Down>` | Earlier prompts to this agent, or earlier commands and searches, only the ones starting with what you've typed |
| INSERT, `:` | `<C-f>` | Edit the line in NORMAL mode: `w` `b` `e` `f`, `dw` `ciw` `di"` `x` `p`, counts, `u`, `.`. `i` or `Esc` goes back to typing, `Enter` sends |
| `:` | `<Tab>` `<S-Tab>` | Complete a command, an agent's name (`:b fla<Tab>`) or a theme, and go through what fits |
| NORMAL | `m{a-z}` `'{a-z}` `''` `<C-o>` `<Tab>` | Marks and the jump list, per agent: back to where you were before `G`, `gg`, a search or a mark. `:marks`, `:jumps` |
| NORMAL, VISUAL | `zz` `zt` `zb` `gv` `<C-g>` | Center the VISUAL cursor's line or the search match, select the last selection again, show where you are |

Copies go to the system clipboard through the terminal (OSC 52), so they work over SSH too. `:help` lists every active key, including yours.
