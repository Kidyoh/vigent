# Vigent — Design Document

A **vim-native, lightweight coding-agent orchestrator** built on the
[pi](https://github.com/badlogic/pi-mono) engine.

Think "T3 Code's orchestration" (parallel agents, worktrees, diff review),
but as a single fast terminal app with the look, feel, and muscle memory of
vim — modal editing, `hjkl`, a statusline, colorschemes, a `:` command line —
instead of an Electron/web GUI.

---

## 1. Why this exists

| | T3 Code / similar orchestrators | Vigent |
|---|---|---|
| UI | Desktop app / web GUI | Pure TUI, instant startup |
| Engine | Wraps external agent CLIs (Codex, Claude Code…) via adapters | Embeds **pi** directly via its SDK — one engine, no adapter zoo |
| Weight | Electron + web stack | Small TypeScript CLI, pi-tui differential rendering |
| Interaction | Mouse-first | Modal, keyboard-first, fully remappable |
| Customization | App settings | Dotfiles: themes, keymaps, config — like a vim setup |

pi is the right engine because it is already the "minimal harness" philosophy
we want: ~4 core tools, small system prompt, multi-provider LLM support
(`pi-ai`), a session/agent runtime (`pi-agent-core`), a TUI rendering library
(`pi-tui`), and three ways to drive it (SDK, RPC, print/JSON mode). We build
the orchestration + vim UX; pi does the agent work.

## 2. What it looks like

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SESSIONS            │  ▸ auth-refactor (claude-sonnet-5-5)   wt: ../wt-auth │
│                     │ ───────────────────────────────────────────────────── │
│ 1 ● auth-refactor   │  user  Refactor the session middleware to use the     │
│ 2 ◐ fix-flaky-test  │        new token store.                               │
│ 3 ○ docs-pass       │                                                       │
│                     │  agent I'll start by reading src/middleware/auth.ts…  │
│   ● running         │   tool read src/middleware/auth.ts                    │
│   ◐ waiting (you)   │   tool edit src/middleware/auth.ts (+41 −18)          │
│   ○ idle/done       │                                                       │
│                     │  agent Done. The middleware now pulls tokens from     │
│                     │        TokenStore. Tests pass (14/14).                │
│                     │                                                       │
├─────────────────────┴────────────────────────────────────────────────────────┤
│ NORMAL │ auth-refactor │ sonnet-5.5 │ ⎇ wt-auth +41 −18 │ 12.3k tok │ 2/3 ● │
├──────────────────────────────────────────────────────────────────────────────┤
│ :                                                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Left sidebar** — session list (acts like vim's buffer list): one line per
  agent, state glyph, name, worktree.
- **Main pane** — the selected session's transcript, scrollable with vim
  motions. Tool calls render collapsed (`za` to fold/unfold, like folds).
- **Statusline** — mode, session, model, worktree + diff stat, token usage,
  running-agents count. Themed like vim statuslines (powerline-ish optional).
- **Command line** — `:` commands and `/` search, bottom row, exactly like vim.

Alternate full-screen views (like vim "windows" you toggle into):

- **Diff view** (`:diff` / `<leader>d`) — unified or side-by-side diff of a
  session's worktree vs its base branch; `]c`/`[c` to jump hunks, `do`-style
  keys later for partial accept.
- **Dashboard** (`:dash`) — grid of all sessions with live status, for when
  you're running 5+ agents.

## 3. Modal model (the vim part)

| Mode | Entered by | What it does |
|---|---|---|
| **NORMAL** | `Esc` (default) | Navigate: scroll transcript, switch sessions, fold tool output, yank |
| **INSERT** | `i`, `o`, `a` | Type a prompt into the composer; `Enter` sends to the focused agent, `Esc` back to NORMAL |
| **VISUAL** | `v` / `V` | Select transcript text; `y` yanks to system clipboard (code blocks are first-class text objects: `yib` = yank inner block) |
| **COMMAND** | `:` | Ex-style commands (below) |
| **SEARCH** | `/`, `?` | Incremental search in transcript; `n`/`N` to jump |

### Default keybindings (all remappable)

- Motion: `j/k`, `gg/G`, `Ctrl-d/u`, `{`/`}` (prev/next message)
- Sessions: `]s`/`[s` next/prev, `1`…`9` jump by number, `dd` kills the
  focused agent (asks first), `Ctrl-^` alternate session
- Leader (default `Space`): `<leader>n` new agent, `<leader>d` diff,
  `<leader>m` merge, `<leader>p` pull request, `<leader>q` queue a follow-up,
  `<leader>t` theme picker, `<leader>D` dashboard
- Folds: `za` toggle tool-call output, `zM`/`zR` close/open all
- Yank: `V`/`v` + `j`/`k` + `y`, `ib` = code block, `yy` = last reply, `yib` = nearest code block

### Ex commands

```
:new <task> [--model id]                spawn an agent in its own worktree (:new! = no worktree)
:kill   :kill!    :pause     :resume    stop (keep / remove worktree), hold, continue
:diff [split]     :merge [--no-squash]  :pr          review and land the work (squash by default)
:attach <branch>                        reopen an agent in a kept worktree
:queue <prompt>                         follow-up for the focused agent
:dash                                   every agent at a glance
:model <id>                             switch model for focused session
:colorscheme <name>   :hi   :set <opt>=<val>   :map <lhs> <rhs>
:w [file]                               export transcript as Markdown
:q   :q!                                quit (refuses while agents run) / quit anyway
:tree                                   pi session tree (not yet)
```

## 4. Configuration — dotfile-first

```
~/.config/vigent/
├── config.toml        # theme, leader, model, [ui] options, [highlights], [keys]
└── themes/            # imported or hand-written colorschemes (TOML / JSON / .vim)
```

One file, vim-shaped: themes use Neovim highlight group names, keys use vim
notation and `:map` semantics, options work with `:set`. The full reference is
[docs/config.md](docs/config.md); themes are covered in [docs/themes.md](docs/themes.md).

```toml
theme = "tokyonight"
leader = "<Space>"

[ui]
sidebar_width = 32

[keys.normal]
"<leader>t" = "theme.picker"
"<Tab>"     = "session.next"

[keys.insert]
"jk" = "<Esc>"
```

## 5. Architecture

```
┌────────────────────────────────────────────────┐
│  vigent (TUI app)                              │
│  modes · keymaps · themes · views · composer   │   built on @mariozechner/pi-tui
├────────────────────────────────────────────────┤
│  orchestrator                                  │
│  SessionSupervisor  — spawn/kill/pause agents  │
│  WorktreeManager    — git worktree per agent   │
│  PromptQueue        — follow-ups per session   │
│  DiffService        — worktree vs base diffs   │
│  EventBus           — agent events → UI        │
├────────────────────────────────────────────────┤
│  engine: pi SDK                                │
│  createAgentSession() per agent                │   @mariozechner/pi-coding-agent
│  SessionManager (persisted session trees)      │   @mariozechner/pi-ai (providers)
│  tools: read / write / edit / bash             │
└────────────────────────────────────────────────┘
```

**Key decision: embed pi via SDK, don't shell out to the `pi` CLI.**
`createAgentSession` + `SessionManager` + `ModelRegistry` give us in-process
sessions with event streams — no RPC plumbing, no parsing CLI output, and we
inherit pi's session trees, auto-compaction, AGENTS.md handling, skills, and
extensions for free. (RPC mode stays an option if we later want crash
isolation per agent.)

**Worktree isolation (the T3 trick):** every `:new <task>` runs
`git worktree add` on a fresh, conventionally named branch
(`:new fix flaky checkout test` → `fix/flaky-checkout-test`); the agent's
tools run in that worktree, so N agents never collide (implemented, see the
README). Next: `:merge` squashes back; `:pr` hands off to `gh`.

**One process, N agents:** agents are just concurrent pi sessions emitting
events onto the bus; the UI renders whichever is focused and keeps badges/
statusline live for the rest. pi-tui's differential renderer keeps this cheap.

## 6. Lightweight principles

1. Terminal only. No Electron, no web server in v1, no daemon.
2. Startup under ~150 ms to first frame.
3. Few deps: pi packages + a TOML parser; everything else hand-rolled.
4. Config is plain files in `~/.config/vigent` — diffable, dotfile-repo-able.
5. Degrade gracefully: 16-color terminals, no nerd-font required (ASCII glyph set).

## 7. Milestones

- **M0 — engine spike.** ✅ pi sessions driven in-process through the SDK.
- **M1 — TUI shell.** ✅ pi-tui app: sidebar, transcript (with a winbar),
  statusline, command line, Neovim-style intro screen.
- **M2 — orchestration.** ✅ Concurrent agents, a git worktree per agent,
  `:new` / `:kill`, session switching, prompt queue, `:pause` / `:resume`.
- **M3 — vim depth.** ✅ NORMAL / INSERT / VISUAL / COMMAND / SEARCH (`/` and
  `?`), folds, `[keys]` in config.toml, theme engine with 8 built-ins and
  import of any vim / nvim colorscheme, 256-color fallback.
- **M4 — review flow.** ✅ `:diff` with `]c` / `[c`, `:merge` (squash by
  default), `:pr`, `:dash`.
- **M5 — polish.** ✅ Agents and their conversations survive a restart
  (`:attach` reopens a kept worktree), side-by-side `:diff split`, Esc typed
  quickly before a key is no longer lost.
- **Not yet.** `:tree` (pi's session tree, branching from an earlier point).
- **Later.** Server/remote mode (phone follows a session), pi extensions
  passthrough, partial-hunk accept, session templates.

## 8. Open questions

1. **Name the composer's editor behavior:** full modal editing inside the
  composer too (mini-vim), or plain input with readline keys? (Today: readline
  keys, `<C-w>` / `<C-u>`; mini-vim is still the lean.)
2. **Lua or TOML for config?** TOML is lighter; an embedded scripting layer
  (quickjs/lua) could come later for power users.
3. **Per-agent model mixing** (cheap model for docs agent, big model for
  refactor agent) — done: `:new <task> --model <id>` and `:model <id>`.
