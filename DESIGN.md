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
- Sessions: `]s`/`[s` next/prev, `1gs`…`9gs` jump by number, `dd` in sidebar
  kills a session (with confirm), `Ctrl-^` alternate session
- Leader (default `Space`): `<leader>n` new agent, `<leader>d` diff,
  `<leader>m` merge, `<leader>q` queue a follow-up prompt, `<leader>t` theme picker
- Folds: `za` toggle tool-call output, `zM`/`zR` close/open all

### Ex commands

```
:new <task>                             spawn an agent in its own worktree (:new! = no worktree)
:kill [name]      :pause     :resume
:diff [name]      :merge [name] [--squash]     :pr [name]
:queue <prompt>                         enqueue follow-up for focused agent
:model <id>                             switch model for focused session
:theme <name>     :set <opt>=<val>      :map <lhs> <rhs>
:tree                                   pi session tree (branch from any point)
:w                                      export transcript (pi /share)
:qa                                     quit (prompts if agents running)
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
│  createAgentSession() per agent                │   @mariozechner/pi-agent-core
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

- **M0 — engine spike.** Node/TS package; drive one pi session via SDK from a
  plain script; print the event stream. Proves the embed works.
- **M1 — TUI shell.** pi-tui app: sidebar + transcript + statusline +
  composer; NORMAL/INSERT; one session; one hardcoded theme.
- **M2 — orchestration.** Multiple concurrent sessions, worktree manager,
  `:new/:kill`, session switching keys, prompt queue.
- **M3 — vim depth.** COMMAND/SEARCH/VISUAL modes, folds, `[keys]` in config.toml,
  theme engine + the 6 built-in colorschemes.
- **M4 — review flow.** Diff view with hunk navigation, `:merge`, `:pr`,
  dashboard view.
- **Later.** Server/remote mode (phone follows a session), pi extensions
  passthrough, partial-hunk accept, session templates.

## 8. Open questions

1. **Name the composer's editor behavior:** full modal editing inside the
  composer too (mini-vim), or plain input with readline keys? (Lean: mini-vim,
  it's the brand.)
2. **Lua or TOML for config?** TOML is lighter; an embedded scripting layer
  (quickjs/lua) could come later for power users.
3. **Per-agent model mixing** (cheap model for docs agent, big model for
  refactor agent) — supported by pi-ai already, just needs UI.
