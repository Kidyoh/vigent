# Porting vigent to Rust

The TypeScript vigent in `src/*.ts` is the spec. This crate has to become a
1:1 replacement: the same features, keys, commands, screen text, config files
and on-disk records, so the repository's tests pass when they drive this
binary. This file maps the crate, names the extension points each area builds
on, and lists every TypeScript feature with the area that owns it.

Six areas port in parallel, each in its own worktree: **Engines**,
**Sessions** (Restore included), **Review**, **Windows**, **Config**,
**Serve**. Each area owns a set of files; adding a feature should mostly mean
adding to your own files, so merges stay clean.

## Build and test

```sh
npm ci && npx tsc                       # dist/, which the tests import
npm run build:binary                    # dist-bin/vigent-linux-x64/vigent
(cd crates/vigent && cargo test --locked)
B=$PWD/dist-bin/vigent-linux-x64/vigent
VIGENT_TTY_BINARY=$B VIGENT_BINARY=$B node --test --test-timeout=90000 test/<file>.test.mjs
npm test                                # the TypeScript; must keep passing
```

Only tests that open a pty (`Tty`) or run the binary exercise Rust; the rest
import `dist/`. Don't change tests or TypeScript to make Rust pass. A test
that can't apply to a native binary stays, and gets reported with the reason.

Worktrees made by riftri are OverlayFS mounts. Remove test worktrees with
`vigent worktree remove <branch> --force` before deleting folders, and check
that `mount | grep -c vigent-` is 0 at the end.

Size matters: std over crates, no async runtime, no HTTP framework. The
release profile is size-tuned. After the foundation the binary is 1,797,880
bytes (1.5 MB before; the config loader, the keymap and a hand-written TOML
reader account for the rest. `toml_edit` would have added ~170 KB, and
`src/config-edit.ts` edits line by line anyway). With the Sessions area it is
2,240,584 bytes: records, restore, races, templates, hooks, notifications,
and riftri's inspect/repair/storage accounting (~90 KB of that is
`storage_accounting` for the "N worktrees: X of files in Y on disk" line;
`riftri_health` uses riftri's storage probe instead of `doctor`, which would
add ~100 KB more).

## Module map

| Rust | TypeScript | What | Owner |
|---|---|---|---|
| `main.rs` | `src/main.ts` | declares modules, calls `cli::main` | shared |
| `cli.rs` | `src/cli.ts` | subcommands (`SUBCOMMANDS`), start flags (`StartOptions`, `START_FLAGS`), startup: config, keymap, theme | shared (add rows) |
| `tui.rs` | `src/tui.ts` | terminal setup, the loop (draw, key/paste, messages, tick), signals | shared |
| `app.rs` | `src/app.ts` | `App`: modes, sessions, focus, input lines, message line, keymap + sequencer, per-area state; `Msg` | shared (keep small) |
| `session.rs` | `src/session.ts`, `CliSession` in `src/cli-engines.ts` | one agent: states, queue, hold/release, pause/resume, abort, transcript items, folding engine events | Sessions |
| `records.rs` | `src/agents.ts` | the agent record in `.git/worktrees/<n>/vigent/agent.json`: format (unknown keys kept), load/save/update, `set_detached`, `restorable`, `reopenable` (riftri views repaired first), `iso_now` | Sessions (Restore) |
| `agents.rs` | `App.startAgent`, `killFocused`, `execAttach`, `execWorktree`, `execQueue`, `watchState`, hooks in `src/app.ts`; `reopen`, `movedOffPi`, `persist`, `forkSession` in `src/cli.ts`; `src/notify.ts`, `src/hooks.ts`, `src/templates.ts` | `impl App` for agents' lives: start (worktree in the background, record saved when it's made), restore at startup, `:kill`/`:attach`/`:worktrees`, queue/pause/resume, forks for splits (`fork_session`, `add_session`), notifications (bell, OSC 9, ◆, focus reporting), `worktree_created`/`agent_finished` hooks, templates, y/n questions (`ask`); its state is `App::agents` | Sessions |
| `tree.rs` | `src/tree.ts` | `:tree` rows from pi's session tree (`flatten`); the pi session feeds it | Sessions |
| `race.rs` | `src/race.ts`, `App.execRace`/`startRace`/`watchRace`/`openRace`/`pickRacer` | `:race` | Sessions |
| `engines/mod.rs` | `src/cli-engines.ts`, `src/engines.ts`, `src/choices.ts` | `Adapter` trait, `RunOpts`, `Ev`, `EngineInfo`, `KNOWN`, `ADAPTERS` registry, `efforts()`, detection | Engines |
| `engines/claude.rs` | `claudeAdapter`, `detectClaude` | Claude Code | Engines |
| `engines/run.rs` | `CliSession.send` | spawns one turn of any adapter, reads its lines on threads | Engines |
| `keys.rs` | `src/keys.ts` | notation, `ACTIONS` (every name), `DEFAULT_KEYS`, `Rhs`, `Keymap`, `build_keymap`, `Sequencer` (timeoutlen), `replay_next` | Config (mappings), shared tables |
| `actions/` | `App.runAction` | handlers by action name, one file per area | each area its file |
| `commands/` | `App.exec` | ex commands, one file per area | each area its file |
| `config.rs` | `src/config.ts`, `templates.ts`, `commands.ts`, `layout.ts`, `style.ts`, `hooks.ts` (names) | every section into structs, warnings, gating, project layering | Config |
| `toml.rs` | smol-toml | TOML reader into `Val` (ordered tables) | Config |
| `theme.rs`, `themes.txt` | `src/theme.ts`, `src/builtin-themes.ts` | built-in themes (themes.txt is written by `scripts/export-themes.mjs`) | Config |
| `worktree.rs` | `src/worktree.ts`, `src/riftri.ts` | plan/make/list/find/remove worktrees with `[worktree]` config, `RIFTRI_BINARY`, branch deletion when merged, riftri ownership/backends/views/gc/health, diff stat from the fork point | Sessions |
| `names.rs` | `agentNameFrom`, `slugify`, `branchName` | names | Sessions |
| `health.rs` | `App.openHealth` | `:checkhealth` | Engines (engines part), Sessions (worktrees part) |
| `help.rs` | `App.openHelp` | `:help` | Config |
| `review.rs` | `src/review.ts`, `hunks.ts`, `hunk-review.ts`, `diffview.ts`, `export.ts` | `Review` state (stub) | Review |
| `windows.rs` | `src/windows.ts`, `line-edit.ts`, `search.ts`, `completion.ts` | `Windows` state (stub) | Windows |
| `serve.rs` | `src/serve.ts`, `serve-page.ts`, `demo.ts`, `notify.ts` | `Serve` state (stub) | Serve |
| `ui/mod.rs` | `App.render` | lays out the parts below | Windows |
| `ui/sidebar.rs` | sidebar | sessions + engines | Windows |
| `ui/transcript.rs`, `ui/markdown.rs` | `buildPaneLines`, `src/markdown.ts` | the transcript | Windows |
| `ui/dashboard.rs` | `DASHBOARD`, start screen | logo, one-key actions, engines | Windows |
| `ui/statusline.rs`, `ui/winbar.rs` | statusline, winbar, message line | | Windows |
| `ui/floats.rs` | `src/float.ts`, `src/picker.ts` | `Float` windows (checkhealth, help) | Windows |
| `ui/text.rs` | `visibleWidth`, wrap | width, fit, pad, wrap | Windows |

## Extension points

**An ex command.** Add a `Command` to `COMMANDS` in `commands/<area>.rs`:

```rust
Command { name: "pause", aliases: &[], also: None, run: pause },
fn pause(app: &mut App, ex: &Ex) { /* ex.arg, ex.raw, ex.bang, ex.name */ }
```

`name!` reaches the same command with `ex.bang` set unless `name!` is listed
itself. `also: Some(fn(&str) -> bool)` claims names a list can't spell
(`nnoremap`, `vunmap`, capitalized user commands). `:!cmd` runs the command
named `"!"`. Unknown names say `E492: Not an editor command: <name>`, as in
TypeScript. A unit test fails if two areas claim the same name.

**A key action.** The name and description are in `keys::ACTIONS` already
(all of `src/keys.ts`); add the handler to `ACTIONS` in `actions/<area>.rs`:

```rust
Action { name: "fold.toggle", run: fold_toggle },
fn fold_toggle(app: &mut App, arg: Option<&str>) { ... }
```

Every default key of the TypeScript vigent is bound from the start
(`keys::DEFAULT_KEYS`); an action without a handler does nothing, so keys
light up as areas port them. Counts (`3gt`, `REPEATABLE`, `countDigit`) are
the Windows area's, in `App::feed`.

**An engine.** A file `engines/<id>.rs` with a type implementing `Adapter`
(`id`, `default_args`, `args(prompt, &RunOpts)`, `parser()`, and optionally
`raw`, `can_fork`, `fork_args`, `models`, `efforts`, `detect`), plus one line
in `engines::ADAPTERS`. The sidebar, start screen, `:checkhealth` and new
agents read `KNOWN` and the registry, so nothing else changes. A parser is a
`Box<dyn FnMut(&Value) -> Vec<Ev>>` and may keep state between lines. New
event kinds are folded into the transcript in `Session::apply`. pi is not a
CLI adapter in TypeScript (it's an RPC session, `src/pi-session.ts`); give
`Session` an engine-specific runner for it rather than forcing it into
`Adapter`. Custom engines (`[engines.<id>] command = [...]`) are parsed into
`config.custom_engines`; turn each into an adapter (`customAdapter`).

**Per-area state.** `App::engines`, `App::review`, `App::windows`,
`App::serve` are each area's own struct, in its own file. Add fields there,
not to `App`. Per-agent state goes on `Session`.

**Work off the UI thread.** Send `Msg::Run(Box::new(move |app| ...))` from
any thread; it runs on the UI thread with `&mut App`. No new `Msg` variant is
needed.

**A part of the screen.** A new file in `ui/` that returns lines or draws
into a `Rect`, and one call in `ui::draw`. Floats are `ui::floats::Float`
(title + lines in highlight groups); pickers and confirm prompts extend it.

**A config section.** An arm in `config::load_str` (and a struct field).
`[ui]` options: a line in `UI_ALIASES` and an arm in `set_option`. Warnings
use the TypeScript wording; gated keys (what runs programs) go in `gated`.
`config::is_trusted` is a stub returning false (Config area: sha256 in
`$XDG_STATE_HOME/vigent/trusted.json`, as `src/trust.ts`).

**A subcommand.** A `Sub` in `cli::SUBCOMMANDS`. **A start flag.** A field in
`StartOptions` and a row in `START_FLAGS`; `cli::main` warns about flags no
area consumes yet (remove your flag from that list when you wire it).

## Differences to know about

- `:theme` with no name shows the theme name; TypeScript opens the picker.
- Claude detection is the milestone-1 version (version + `auth status`); port
  `detectClaude`'s API-key fallbacks and `detail` strings.
- The Claude parser doesn't emit `Message`, `Thinking`, `TurnEnd`,
  `TurnStart`, `Denied` or the early `content_block_start` tool line yet.
- `:checkhealth`, `:help`, the sidebar and the start screen keep milestone-1
  wording ("next milestone", "milestone 2 adds the rest"); replace it with the
  TypeScript text as engines land.
- Sessions area, what other areas hook into:
  - Windows: a split on the same agent calls `app.fork_session(slot)` (an
    `Err` is the message to show; refuse first while it's running, as
    `splitWindow` does) and adds the fork with `app.add_session(fork, true)`.
    `App::on_screen(slot)` is the focused agent only; make it count every
    window of a split (notifications and races read it). The race and queue
    lists, `:worktrees` and `:templates` are plain floats until pickers exist
    (Enter doesn't open/start one yet). `ask()` shows its y/n question as the
    message; the TypeScript draws it on the command line with a cursor.
  - Engines: `:model`/`:effort` call `app.persist(slot)` so a restart keeps
    them. pi agents (no engine on record, or `pi`) reopen with pi's
    `error: pi isn't installed` and the hint when pi isn't on PATH; a pi
    session should replace that, read `records::session_dir`, and give `:tree`
    its rows (src/tree.ts is not ported). `movedOffPi` uses
    `App::new_agent_engine()`, so "the engine that's signed in" depends on
    detection of Codex etc. `--engine` sets `config.engine` (what
    `new_agent_engine` reads); `--engine pi` is accepted so pi's agents reopen.
  - Serve: `:usage`/`:cost` read `Session::tokens`/`cost` (restored from the
    record) and `session::total_usage`/`format_usage`.
- Kill keeps the slot (`Session::closed`): `App::open()` is the list the
  TypeScript's `sessions` array is; forks name their original by slot (`fork_of`).

## Pty tests and where they stand

Through the Rust binary, these pass today: all of `standalone`,
`worktree-background`, `reopen-without-pi` 1, 3 and 4, and the non-binary
parts of the others. These fail and are the areas' targets:

| Test | Area |
|---|---|
| custom-engines 7: the real vigent runs a custom engine from config.toml | Engines |
| e2e 2: first run ... follows up, and comes back after a restart (all but `:effort`/`:model` pass: the restart part does, run without those lines) | Engines |
| e2e 3: @ in a prompt: pick a file | Windows (line editor, attach picker) |
| e2e 5: no agent CLI and no API key: the demo starts | Serve (demo) |
| fork 5: a split forks once (Sessions' `fork_session` is there; needs `<C-w>v` and the Claude parser's `Message` event) | Windows (splits), Engines |
| layout 6: sidebar on the right and a statusline of your own | Windows |
| permissions-panel 4: two vigents open at once | Engines |
| pi-live 1: vigent --engine pi | Engines |
| project-config 12: untrusted .vigent.toml, :trust, vigent trust | Config |
| reopen-without-pi 2: moves to the engine that's signed in (1, 3, 4 pass; 2 needs Codex detection) | Engines |
| user-commands 5: a [commands] shell command from config.toml | Config |

## Parity checklist

`[x]` Rust has it · `[~]` partly · `[ ]` not yet. Area in **bold**.

### CLI (`src/cli.ts`)

- [x] `vigent --version` / `-v` / `version` (no stale-build warning: a binary has no clone) — **Config**
- [x] `vigent --help` / `-h` (Rust's own text; TypeScript's lists every subcommand) — **Config**
- [x] `vigent [folder]` — **Sessions**
- [x] `--theme <name>` — **Config**
- [~] `--engine <id>`: unknown engine exits 1 as in TypeScript; a known engine this build can't run exits 1 too; `claude` runs — **Engines**
- [ ] `--model <id>` — **Engines**
- [ ] `--demo` (and the automatic demo when nothing can run agents) — **Serve**
- [ ] `--serve [--local]` — **Serve**
- [x] `vigent theme list` (built-ins; installed themes in `~/.config/vigent/themes` too) — **Config** `[~]`
- [ ] `vigent theme path` — **Config**
- [ ] `vigent theme new <name> [--from <theme>] [--palette] [--transparent|--no-transparent]` — **Config**
- [ ] `vigent theme import [name|file] [--as <name>] [--vim|--nvim] [--light|--dark] [--clean]` — **Config**
- [x] `vigent worktree list` (`worktrees`, `wt`; backend names, detached worktrees) — **Sessions**
- [x] `vigent worktree remove|rm <branch> [--force]` (finds by branch, folder, path or agent name; deletes a merged branch) — **Sessions**
- [x] `vigent worktree prune` — **Sessions**
- [x] `vigent worktree gc` — **Sessions**
- [ ] `vigent config init` (writes `CONFIG_TEMPLATE`) — **Config**
- [ ] `vigent config check` — **Config**
- [ ] `vigent trust` — **Config**
- [~] startup: config + project config + keymap warnings on the message line (`app.notify`) — **Config**
- [x] startup: reopen agents whose worktrees remain (`reopenableAgents`, riftri views first), engine fallback when pi is gone (picks what `new_agent_engine` says: Codex etc. need Engines' detection) — **Sessions**
- [ ] startup: `theme = "nvim"|"vim"` follows your editor (`src/follow.ts`) — **Config**

### Ex commands (`App.exec` in `src/app.ts`)

Core / windows and buffers:
- [x] `:q` `:quit` `:x` `:wq` `:qa` `:qall` `:xa` `:wqa` (E37 when running), `:q!` `:quit!` `:qa!` `:qall!` — core; closing a split first is **Windows**
- [x] `:help` `:h` (list every binding, yours too) — **Config** `[~]`
- [ ] `:split` `:sp`, `:vsplit` `:vs` `:vsp` (with an agent: fork) — **Windows**
- [ ] `:only` `:on`, `:close` `:clo`, `:wincmd` `:winc` — **Windows**
- [ ] `:bnext` `:bn`, `:bprevious` `:bprev` `:bp` `:bNext` `:bN`, `:buffer` `:b <agent>` — **Windows**
- [ ] `:ls` `:buffers` `:files`, `:dash` `:dashboard` — **Windows**
- [ ] `:noh` `:nohl` `:nohlsearch` — **Windows**
- [ ] `:marks`, `:jumps`, `:his` `:history` — **Windows**

Sessions:
- [x] `:new <name>`, `:new!`, `--model`, `--engine`/`-e`, `--template`/`-t` — **Sessions**
- [x] `:kill` `:kill!` `:bdelete` `:bd` — **Sessions**
- [x] `:queue [prompt]` (the list is a float, not a picker) — **Sessions**
- [x] `:pause`, `:resume` — **Sessions**
- [~] `:race <task> [--engines a,b] [--models x,y] [-t tpl]`, `:race`, `:race pick`, `:race! pick` (`:race` is a float: no Enter to open a racer; Tab completion is Windows'; `--models` reads `Adapter::models`) — **Sessions**
- [~] `:templates` `:template` `:tpl [name]` (no name: a float listing them, not a picker) — **Sessions**
- [~] `:tree` (and fork from a point): what CLI agents say; the tree itself is pi's (src/tree.ts, with the pi session) — **Sessions** with **Engines**
- [x] `:worktrees` `:worktree` `:wt`, `:worktree remove[!] <branch>` — **Sessions**
- [x] `:attach <branch>` — **Sessions**

Engines:
- [~] `:checkhealth` `:che` `:engines` (Rust also keeps `:health`) — **Engines**
- [ ] `:model` `:mo [model]` (picker without an argument) — **Engines**
- [ ] `:engine` `:eng [id]` — **Engines**
- [ ] `:effort` `:think [level]` — **Engines**
- [ ] `:permissions` `:permission` `:perms` `:perm`, `allow <rule>`, `remove <rule>` — **Engines**
- [ ] `:pi` `:extensions` — **Engines**

Review:
- [ ] `:diff`, `:diff split|vert|vertical|side` — **Review**
- [ ] `:review` `:hunks` — **Review**
- [ ] `:merge [--no-squash]` (before_merge hook) — **Review**
- [ ] `:pr` (before_merge hook) — **Review**
- [ ] `:w` `:write [file]`, `:w!` `:write!` (transcript as Markdown) — **Review**

Config:
- [~] `:colorscheme` `:colo` `:theme [name]` (picker without a name), `:theme save[!] [name]` — **Config**
- [ ] `:hi` `:highlight` `:hi!` `:highlight!` (`Group guifg=… guibg=… gui=…`, `link A B`, `clear`) — **Config**
- [ ] `:set` `:se` (`applySetCommand`: `opt`, `noopt`, `opt!`, `invopt`, `opt=val`, `opt?`, `opt&`) — **Config**
- [ ] `:settings` `:options` `:prefs` — **Config**
- [ ] `:let mapleader = "<key>"` — **Config**
- [ ] `:map` `:nmap` `:imap` `:cmap` `:vmap` `:xmap` and `…noremap` — **Config**
- [ ] `:unmap` `:nunmap` `:iunmap` `:cunmap` `:vunmap` `:xunmap` — **Config**
- [ ] `:command[!]` `:com[!]`, `:delcommand` `:delc`, user commands (`Name args`) — **Config**
- [ ] `:!{command}` (in the agent's worktree) — **Config**
- [ ] `:trust` — **Config**

Serve:
- [ ] `:serve [port] [local]`, `:serve stop`, serve info float — **Serve**
- [ ] `:cost` `:usage` — **Serve**

### Keys (`src/keys.ts` `DEFAULT_KEYS`; every one is bound, handlers below)

Normal mode:
- [x] `i` `a` `o` mode.insert; [ ] `I` mode.insert_start, `A` mode.append_end (need a cursor) — core / **Windows**
- [x] `:` mode.command — core
- [ ] `/` mode.search, `?` mode.search_back, `n` `N`, `<Esc>` search.clear — **Windows**
- [ ] `v` `V` mode.visual and all of VISUAL (`j k <C-d> <C-u> <C-f> <C-b> H M L gg G y ib o zz zt zb <Esc> v V`) — **Windows**
- [x] `j` `k` `<Down>` `<Up>` `<C-e>` `<C-y>` `<C-n>` `<C-p>` `<C-d>` `<C-u>` `<C-f>` `<C-b>` `<PageDown>` `<PageUp>` `gg` `G` — **Windows**
- [x] `]s` `[s` `gt` `gT`; [x] `<C-^>` session.alternate; [x] `<leader>1`…`<leader>9` — **Sessions**
- [ ] counts (`3gt`, `5j`, `<C-w>` with a count) — **Windows**
- [ ] `za` `zR` `zM` `zr` `zm` folds — **Windows**
- [ ] `{` `}` message.prev/next, `zz` `zt` `zb`, `<C-o>` `<Tab>` jumps, `<C-g>`, `gv` — **Windows**
- [ ] `yy` yank.reply, `yib` yank.block (OSC 52 clipboard, `src/clipboard.ts`) — **Windows**
- [x] `dd` session.kill (asks first) — **Sessions**
- [x] `<C-c>` session.abort — **Sessions**
- [ ] `<C-h>` `<BS>` `<C-l>` `<C-j>` `<C-k>`, all `<C-w>…` window keys, `<leader>|` `<leader>-` — **Windows**
- [ ] `<leader>e` sidebar.focus and the sidebar's own keys (j k Enter Esc l o d a p w …) — **Windows**
- [ ] `<leader>n` `:new `, `<leader>q` `:queue ` (open the command line: works), `<leader>d` `:diff`, `<leader>m` `:merge`, `<leader>p` `:pr`, `<leader>D` `:dash`, `<leader>s` `:settings`, `<leader>r` `:review`, `<leader>T` `:templates`, `<leader>M` `:model`, `<leader>R` `:effort`, `<leader>E` `:engine` — each command's area
- [ ] `<leader>t` theme.picker — **Config**; [~] `<leader>u` session.tree (as `:tree`) — **Sessions**
- [x] `ZZ` `ZQ` app.quit / app.quit_force, `q` app.quit_hint — core
- [~] start screen keys: [x] `i` `n` `c` `?` `q`; [ ] `T` `t` `s` `m` `e` `E` — each area
- [ ] which-key hint after `<leader>` (`[ui] whichkey`) — **Windows**
- [ ] showcmd (pending keys on the statusline) — **Windows**

Insert and command line:
- [x] `<Esc>` `<C-c>` mode.normal, `<CR>` edit.submit, `<BS>` `<C-h>` edit.backspace, `<C-w>` edit.delete_word, `<C-u>` edit.clear — core
- [ ] a real cursor (`src/line-edit.ts`): `<Del>` `<Left>` `<Right>` `<Home>` `<End>` `<C-Left>` `<S-Left>` `<C-Right>` `<S-Right>` `<C-b>` `<C-e>` — **Windows**
- [ ] history `<Up>` `<Down>` `<C-p>` `<C-n>` (prefix match), `<C-r>"` paste, `<C-f>` line NORMAL mode (motions, operators, text objects, undo) — **Windows**
- [ ] `<Tab>` `<S-Tab>` completion (commands, agents, themes, wildmenu) — **Windows**
- [ ] `@` file picker in a prompt (`src/attach.ts`) — **Windows**
- [x] bracketed paste — core

### Config (`config.toml`, `.vigent.toml`)

Parsing every section with TypeScript's warnings is done (`config.rs`); `[x]`
below means it's also *used*.
- [x] `theme` / `colorscheme` — **Config**
- [ ] `model` (pi's model) — **Engines**
- [ ] `engine` (`auto`, a built-in, or a custom one) — **Engines**
- [x] `leader` / `mapleader` — **Config**
- [ ] `[ui]` `sidebar`, `sidebar_width`, `sidebar_position`, `number`, `tilde`, `icons`, `termguicolors`, `transparent`, `whichkey` — **Windows** (`[x]` `timeoutlen`); [x] `notify` — **Sessions**
- [ ] `[engines.<id>]` `args`, `model`, `effort` — **Engines**; `allow`, `ask` — **Engines**
- [ ] `[engines.<id>]` with `command`: `name`, `output`, `model_args`, `models`, `resume_args` — **Engines**
- [x] `[keys]`, `[keys.normal|insert|visual|command]` — **Config**
- [ ] `[highlights]` (tables, `:hi` strings, links) — **Config**
- [x] `[worktree]` `enabled`, `dir`, `branch`, `base`, `backend` — **Sessions**
- [x] `[templates.<name>]` `prompt`, `description`, `engine`, `model`, `effort`, `worktree` (+ built-ins fix, test, review, explain) — **Sessions**
- [x] `[hooks]` `worktree_created` (holds the first prompt), `agent_finished` — **Sessions** (`agents::run_hook`); [ ] `before_merge` — **Review**
- [ ] `[statusline]` / `[winbar]` `left`, `right` — **Windows**
- [ ] `[commands]` — **Config**
- [ ] `[style]` `sidebar`, `messages`, `tool_icons`, `separators`, `user_label`, `[style.icons]`, `[style.nerd_icons]` — **Windows**
- [~] project `.vigent.toml` layered over yours, gated until trusted (`is_trusted` stub) — **Config**
- [ ] theme files in `~/.config/vigent/themes` (`.toml`, `.json`, `.vim`), `extends`, palettes, `[style]` in themes — **Config**

### Engines

- [x] Claude Code (`claude -p --output-format stream-json`), resume — **Engines** `[~]` (model/effort/fork args are built; no `:model`)
- [ ] Codex (`codex exec --json`) — **Engines**
- [ ] OpenCode — **Engines**
- [ ] Gemini CLI — **Engines**
- [ ] Cursor CLI (`cursor-agent`) — **Engines**
- [ ] pi (`pi --mode rpc`: `src/pi-session.ts`, `pi-cli.ts`, `pi-ui.ts`, extensions, tree) — **Engines**
- [ ] custom engines from `[engines.<id>]` — **Engines**
- [~] detection: installed, version, signed in, `dropEnv` — **Engines**
- [ ] `defaultEngine` (auto: first signed-in CLI, else pi with a key) — **Engines**
- [ ] model and effort choices (`src/choices.ts`) — **Engines**
- [ ] Claude Code permission denials: ask to allow once/always, retry (`askToAllow`), `:permissions` panel and its file — **Engines**
- [~] fork a conversation (`--fork-session`, `--resume-session-at`): `App::fork_session`, `last_claude_message`, fork runs once then keeps its own id; the split is **Windows**', the Claude `Message` event **Engines**' — **Sessions** with **Engines**

### Sessions, Review, Windows, Serve features beyond commands and keys

- [x] an agent per worktree (riftri, git fallback), made in the background; prompts wait — **Sessions**
- [x] queue while running, drain after the CLI exits — **Sessions**
- [x] an agent that finishes while you look elsewhere is unread (◆) until you open it; `waiting` is "needs you", as in TypeScript — **Sessions**
- [x] agent records saved (made, conversation id, totals and settings at the end of each run) and reopened; usage totals survive a restart — **Sessions**
- [x] `:kill` marks the record detached; `:attach` reopens — **Sessions**
- [x] races (`src/race.ts`): racers start when every worktree is made, the race-over message ranks them, the bell for unseen ones — **Sessions**
- [ ] conversation tree (`src/tree.ts`): pi's, waits for the pi session — **Sessions** with **Engines**
- [x] riftri storage health in `:checkhealth` (`riftriHealth`) and the `:worktrees` footer — **Sessions**
- [ ] diff view, hunk review, merge, PR, transcript export — **Review**
- [ ] splits, sidebar focus, search, VISUAL, folds, marks, jumps, tool output folding, markdown (`src/markdown.ts`), icons (`src/icons.ts`), styles (`src/style.ts`), pickers (`src/picker.ts`), confirm prompts — **Windows**
- [x] desktop notification / bell when an agent finishes elsewhere, focus reporting, `[ui] notify` (`src/notify.ts`, in agents.rs) — **Sessions**
- [ ] `:serve` web page over std's `TcpListener` (`src/serve.ts`, `src/serve-page.ts`) — **Serve**
- [ ] demo sessions (`src/demo.ts`, `DemoSession`) — **Serve**
- [ ] usage float (`:usage`) — **Serve**
