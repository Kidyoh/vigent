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
`src/config-edit.ts` edits line by line anyway).

## Module map

| Rust | TypeScript | What | Owner |
|---|---|---|---|
| `main.rs` | `src/main.ts` | declares modules, calls `cli::main` | shared |
| `cli.rs` | `src/cli.ts` | subcommands (`SUBCOMMANDS`), start flags (`StartOptions`, `START_FLAGS`), startup: config, keymap, theme | shared (add rows) |
| `tui.rs` | `src/tui.ts` | terminal setup, the loop (draw, key/paste, messages, tick), signals | shared |
| `app.rs` | `src/app.ts` | `App`: modes, sessions, focus, input lines, message line, keymap + sequencer, per-area state; `Msg` | shared (keep small) |
| `session.rs` | `src/session.ts`, `CliSession` in `src/cli-engines.ts` | one agent: states, queue, hold/release, pause/resume, abort, transcript items, folding engine events | Sessions |
| `records.rs` | `src/agents.ts` | the agent record in `.git/worktrees/<n>/vigent/agent.json` (stub: format + load/save) | Sessions (Restore) |
| `engines/mod.rs` | `src/cli-engines.ts`, `src/engines.ts`, `src/choices.ts` | `Adapter` trait, `RunOpts`, `Ev`, `EngineInfo`, `KNOWN`, `ADAPTERS` registry, `efforts()`, detection | Engines |
| `engines/claude.rs` | `claudeAdapter`, `detectClaude` | Claude Code | Engines |
| `engines/run.rs` | `CliSession.send` | spawns one turn of any adapter, reads its lines on threads | Engines |
| `keys.rs` | `src/keys.ts` | notation, `ACTIONS` (every name), `DEFAULT_KEYS`, `Rhs`, `Keymap`, `build_keymap`, `Sequencer` (timeoutlen), `replay_next` | Config (mappings), shared tables |
| `actions/` | `App.runAction` | handlers by action name, one file per area | each area its file |
| `commands/` | `App.exec` | ex commands, one file per area | each area its file |
| `config.rs` | `src/config.ts`, `templates.ts`, `commands.ts`, `layout.ts`, `style.ts`, `hooks.ts` (names) | every section into structs, warnings, gating, project layering | Config |
| `toml.rs` | smol-toml | TOML reader into `Val` (ordered tables) | Config |
| `trust.rs` | `src/trust.ts` | trusted project files (sha256), `:trust`, `vigent trust` | Config |
| `config_edit.rs` | `src/config-edit.ts` | one value set in config.toml, comments kept | Config |
| `settings.rs` | `src/settings.ts`, `openSettings` | the settings panel (also :permissions'), `ConfigState` (`app.cfg`) | Config |
| `permissions.rs` | `src/permissions.ts`, `openPermissions` | permission helpers, the panel, saving and reloading | Config |
| `looks.rs` | `openThemePicker`, `saveTheme`, `execHighlight`, `applySetCommand` | :colorscheme picker, :theme save, :hi, :set | Config |
| `style.rs` | `src/style.ts`, `src/icons.ts`, `ICONS` | the style in effect and the glyphs (`style::icons(app)`) | Config |
| `layout.rs` | `src/layout.ts`, `renderStatusline`, `renderWinbar` | statusline and winbar parts | Config |
| `templates.rs` | `src/templates.ts` | templates, `:templates` picker, `templates::start` | Config |
| `usercmd.rs` | `src/commands.ts`, `runShell`, `src/hooks.ts` runHook | your commands, `:!cmd`, `run_hook` | Config |
| `demo.rs` | `src/demo.ts`, `DemoSession` | scripted agents for `--demo` | Config |
| `color.rs`, `vimcolors.rs`, `suggest.rs` | `src/color.ts`, `src/vimcolors.ts`, `src/suggest.ts` | colors, :hi syntax and .vim files, did-you-mean | Config |
| `import.rs`, `follow.rs`, `themecli.rs` | `src/import.ts`, `src/follow.ts`, `src/theme-new.ts`, themeCommand | `vigent theme import/new/path/list`, following the editor | Config |
| `theme.rs`, `themes.txt` | `src/theme.ts`, `src/palette.ts`, `src/builtin-themes.ts` | the theme engine (links, derived groups, overrides, transparency, 256 colors), theme files, palettes; themes.txt (with `@palette`/`@style` lines) is written by `scripts/export-themes.mjs` | Config |
| `worktree.rs` | `src/worktree.ts`, `src/riftri.ts` | plan/make/list/remove worktrees, diff stat | Sessions |
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

- Rust's `:new <task>` names the agent after the task *and sends it as the
  first prompt*; TypeScript's `:new <name>` only starts an agent by that name.
  Sessions area: match TypeScript (check `test/e2e.test.mjs` and the help text).
- `:new!` (an agent in your checkout) says `E477: No ! allowed` for now.
- Config area notes: `:templates`, `:permissions` and `--demo` were ported by
  the Config area (its task listed them); `templates::start(app, name, task,
  StartOpts)` is what Sessions' `:new -t` should call, and `permissions::reload`
  / `engine_args` are what an engine reads at each prompt. A demo agent can't
  be stopped with <C-c> yet (its script plays on a thread). The theme picker
  filters with "the letters in order" rather than pi-tui's fuzzy score. `:hi
  Group` shows the attributes but not the colored `xxx` sample. The style's
  cards / compact sidebar and labeled / bubble messages are resolved
  (`style::resolve`, `style::icons`) but drawn the tree / plain way until the
  sidebar and transcript read them (Windows).
- Claude detection is the milestone-1 version (version + `auth status`); port
  `detectClaude`'s API-key fallbacks and `detail` strings.
- The Claude parser doesn't emit `Message`, `Thinking`, `TurnEnd`,
  `TurnStart`, `Denied` or the early `content_block_start` tool line yet.
- `:checkhealth`, `:help`, the sidebar and the start screen keep milestone-1
  wording ("next milestone", "milestone 2 adds the rest"); replace it with the
  TypeScript text as engines land.

## Pty tests and where they stand

Through the Rust binary, these pass today: all of `standalone`, and the
non-binary parts of the others. These fail and are the areas' targets:

| Test | Area |
|---|---|
| custom-engines 7: the real vigent runs a custom engine from config.toml | Engines |
| e2e 2: first run ... follows up, and comes back after a restart | Sessions (Restore), Engines |
| e2e 3: @ in a prompt: pick a file | Windows (line editor, attach picker) |
| e2e 5: no agent CLI and no API key: the demo starts | Config (done) |
| fork 5: a split forks once | Windows (splits), Sessions (fork) |
| layout 6: sidebar on the right and a statusline of your own | Config (done) |
| permissions-panel 4: two vigents open at once | Config (done) |
| pi-live 1: vigent --engine pi | Engines |
| project-config 12: untrusted .vigent.toml, :trust, vigent trust | Config (done) |
| reopen-without-pi 1-4 | Sessions (Restore), Engines |
| user-commands 5: a [commands] shell command from config.toml | Config (done) |
| worktree-background 2: keys while a worktree is made, the prompt waits | Sessions |

## Parity checklist

`[x]` Rust has it · `[~]` partly · `[ ]` not yet. Area in **bold**.

### CLI (`src/cli.ts`)

- [x] `vigent --version` / `-v` / `version` (no stale-build warning: a binary has no clone) — **Config**
- [x] `vigent --help` / `-h` (src/cli.ts's text word for word, `help.txt`; `--help`/`--version` anywhere on the line) — **Config**
- [~] `vigent [folder]` — **Sessions**
- [x] `--theme <name>` — **Config**
- [~] `--engine <id>`: unknown engine exits 1 as in TypeScript; a known engine this build can't run exits 1 too; `claude` runs — **Engines**
- [ ] `--model <id>` — **Engines**
- [x] `--demo` (and the automatic demo when nothing can run agents; `demo.rs`) — **Config**
- [ ] `--serve [--local]` — **Serve**
- [x] `vigent theme list` (built-ins marked, installed themes in `~/.config/vigent/themes` too) — **Config**
- [x] `vigent theme path` — **Config**
- [x] `vigent theme new <name> [--from <theme>] [--palette] [--transparent|--no-transparent]` — **Config**
- [x] `vigent theme import [name|file] [--as <name>] [--vim|--nvim] [--light|--dark] [--clean]` — **Config**
- [x] `vigent worktree list` (`worktrees`, `wt`) — **Sessions**
- [x] `vigent worktree remove|rm <branch> [--force]` — **Sessions**
- [ ] `vigent worktree prune` — **Sessions**
- [ ] `vigent worktree gc` — **Sessions**
- [x] `vigent config init` (writes `CONFIG_TEMPLATE`, `config_template.toml` exported from dist/config.js) — **Config**
- [x] `vigent config check` — **Config**
- [x] `vigent trust` — **Config**
- [x] startup: config + project config + keymap warnings on the message line (`app.notify`), the demo note first — **Config**
- [ ] startup: reopen agents whose worktrees remain (`reopenableAgents`, riftri views first), engine fallback when pi is gone — **Sessions**
- [x] startup: `theme = "nvim"|"vim"` follows your editor (`follow.rs`) — **Config**

### Ex commands (`App.exec` in `src/app.ts`)

Core / windows and buffers:
- [x] `:q` `:quit` `:x` `:wq` `:qa` `:qall` `:xa` `:wqa` (E37 when running), `:q!` `:quit!` `:qa!` `:qall!` — core; closing a split first is **Windows**
- [x] `:help` `:h` (every binding from the keymap, yours first, then EX_HELP) — **Config**
- [ ] `:split` `:sp`, `:vsplit` `:vs` `:vsp` (with an agent: fork) — **Windows**
- [ ] `:only` `:on`, `:close` `:clo`, `:wincmd` `:winc` — **Windows**
- [ ] `:bnext` `:bn`, `:bprevious` `:bprev` `:bp` `:bNext` `:bN`, `:buffer` `:b <agent>` — **Windows**
- [ ] `:ls` `:buffers` `:files`, `:dash` `:dashboard` — **Windows**
- [ ] `:noh` `:nohl` `:nohlsearch` — **Windows**
- [ ] `:marks`, `:jumps`, `:his` `:history` — **Windows**

Sessions:
- [~] `:new <task>`, `:new!`, `--model`, `--engine`/`-e`, `--template`/`-t` — **Sessions**
- [~] `:kill` `:kill!` `:bdelete` `:bd` — **Sessions**
- [ ] `:queue [prompt]` — **Sessions**
- [ ] `:pause`, `:resume` (session.rs has pause/resume/hold/release) — **Sessions**
- [ ] `:race <task> [--engines a,b] [--models x,y] [-t tpl]`, `:race`, `:race pick`, `:race! pick` — **Sessions**
- [x] `:templates` `:template` `:tpl [name]` (`templates.rs`; `templates::start` is what `:new -t` calls) — **Config**
- [ ] `:tree` (and fork from a point) — **Sessions**
- [ ] `:worktrees` `:worktree` `:wt`, `:worktree remove[!] <branch>` — **Sessions**
- [ ] `:attach <branch>` — **Sessions**

Engines:
- [~] `:checkhealth` `:che` `:engines` (Rust also keeps `:health`) — **Engines**
- [ ] `:model` `:mo [model]` (picker without an argument) — **Engines**
- [ ] `:engine` `:eng [id]` — **Engines**
- [ ] `:effort` `:think [level]` — **Engines**
- [x] `:permissions` `:permission` `:perms` `:perm`, `allow <rule>`, `remove <rule>` (`permissions.rs`: saved at once, reloaded first so two vigents don't undo each other) — **Config**
- [ ] `:pi` `:extensions` — **Engines**

Review:
- [ ] `:diff`, `:diff split|vert|vertical|side` — **Review**
- [ ] `:review` `:hunks` — **Review**
- [ ] `:merge [--no-squash]` (before_merge hook) — **Review**
- [ ] `:pr` (before_merge hook) — **Review**
- [ ] `:w` `:write [file]`, `:w!` `:write!` (transcript as Markdown) — **Review**

Config:
- [x] `:colorscheme` `:colo` `:theme [name]` (picker with live preview without a name), `:theme save[!] [name]` — **Config**
- [x] `:hi` `:highlight` `:hi!` `:highlight!` (`Group guifg=… guibg=… gui=…`, `link A B`, `clear`) — **Config**
- [x] `:set` `:se` (`applySetCommand`: `opt`, `noopt`, `opt!`, `invopt`, `opt=val`, `opt?`, `opt&`) — **Config**
- [x] `:settings` `:options` `:prefs` (`settings.rs`; w saves with `config_edit.rs`, comments kept) — **Config**
- [x] `:let mapleader = "<key>"` — **Config**
- [x] `:map` `:nmap` `:imap` `:cmap` `:vmap` `:xmap` and `…noremap` — **Config**
- [x] `:unmap` `:nunmap` `:iunmap` `:cunmap` `:vunmap` `:xunmap` — **Config**
- [x] `:command[!]` `:com[!]`, `:delcommand` `:delc`, user commands (`Name args`) — **Config**
- [x] `:!{command}` (in the agent's worktree; `usercmd.rs`) — **Config**
- [x] `:trust` — **Config**

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
- [x] `]s` `[s` `gt` `gT`; [ ] `<C-^>` session.alternate; [x] `<leader>1`…`<leader>9` — **Sessions**
- [ ] counts (`3gt`, `5j`, `<C-w>` with a count) — **Windows**
- [ ] `za` `zR` `zM` `zr` `zm` folds — **Windows**
- [ ] `{` `}` message.prev/next, `zz` `zt` `zb`, `<C-o>` `<Tab>` jumps, `<C-g>`, `gv` — **Windows**
- [ ] `yy` yank.reply, `yib` yank.block (OSC 52 clipboard, `src/clipboard.ts`) — **Windows**
- [ ] `dd` session.kill (asks first: CONFIRM) — **Sessions**
- [x] `<C-c>` session.abort — **Sessions**
- [ ] `<C-h>` `<BS>` `<C-l>` `<C-j>` `<C-k>`, all `<C-w>…` window keys, `<leader>|` `<leader>-` — **Windows**
- [ ] `<leader>e` sidebar.focus and the sidebar's own keys (j k Enter Esc l o d a p w …) — **Windows**
- [ ] `<leader>n` `:new `, `<leader>q` `:queue ` (open the command line: works), `<leader>d` `:diff`, `<leader>m` `:merge`, `<leader>p` `:pr`, `<leader>D` `:dash`, `<leader>s` `:settings`, `<leader>r` `:review`, `<leader>T` `:templates`, `<leader>M` `:model`, `<leader>R` `:effort`, `<leader>E` `:engine` — each command's area
- [x] `<leader>t` theme.picker — **Config**; `<leader>u` session.tree — **Sessions**
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
- [~] `[ui]` `sidebar`, `sidebar_width`, `sidebar_position` (`[x]`, ui/mod.rs), `termguicolors`, `transparent` (`[x]`, theme.rs), `icons` (`[x]` glyph tables in style.rs), `number`, `tilde`, `whichkey` — **Windows** (`[x]` `timeoutlen`); `notify` — **Serve**
- [ ] `[engines.<id>]` `args`, `model`, `effort` — **Engines**; `allow`, `ask` — **Engines**
- [ ] `[engines.<id>]` with `command`: `name`, `output`, `model_args`, `models`, `resume_args` — **Engines**
- [x] `[keys]`, `[keys.normal|insert|visual|command]` — **Config**
- [x] `[highlights]` (tables, `:hi` strings, links) — **Config**
- [ ] `[worktree]` `enabled`, `dir`, `branch`, `base`, `backend` — **Sessions**
- [ ] `[templates.<name>]` `prompt`, `description`, `engine`, `model`, `effort`, `worktree` (+ built-ins fix, test, review, explain) — **Sessions**
- [ ] `[hooks]` `worktree_created` (holds the first prompt), `agent_finished` — **Sessions**; `before_merge` — **Review**
- [x] `[statusline]` / `[winbar]` `left`, `right`, powerline shapes (`layout.rs`) — **Config**
- [x] `[commands]` — **Config**
- [~] `[style]` `sidebar`, `messages`, `tool_icons`, `separators`, `user_label`, `[style.icons]`, `[style.nerd_icons]`: resolved with the theme's (`style::resolve`, `style::icons`), separators drawn; cards/compact sidebar and labeled/bubble messages are for the sidebar and transcript to draw — **Windows**
- [x] project `.vigent.toml` layered over yours, gated until trusted (`trust.rs`: sha256 in `$XDG_STATE_HOME/vigent/trusted.json`) — **Config**
- [x] theme files in `~/.config/vigent/themes` (`.toml`, `.json`, `.vim`), `extends`, palettes, `[style]` in themes — **Config**

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
- [ ] fork a conversation (`--fork-session`, `--resume-session-at`) — **Sessions** with **Engines**

### Sessions, Review, Windows, Serve features beyond commands and keys

- [x] an agent per worktree (riftri, git fallback), made in the background; prompts wait — **Sessions**
- [x] queue while running, drain after the CLI exits — **Sessions**
- [x] waiting state when an agent finishes while you look elsewhere — **Sessions**
- [ ] agent records saved and reopened (`records.rs` has the format) — **Sessions**
- [ ] `:kill` marks the record detached; `:attach` reopens — **Sessions**
- [ ] races (`src/race.ts`) — **Sessions**
- [ ] conversation tree (`src/tree.ts`) — **Sessions**
- [ ] riftri storage health in `:checkhealth` (`riftriHealth`) — **Sessions**
- [ ] diff view, hunk review, merge, PR, transcript export — **Review**
- [ ] splits, sidebar focus, search, VISUAL, folds, marks, jumps, tool output folding, markdown (`src/markdown.ts`), icons (`src/icons.ts`), styles (`src/style.ts`), pickers (`src/picker.ts`), confirm prompts — **Windows**
- [ ] desktop notification / bell when an agent finishes elsewhere, focus reporting (`src/notify.ts`) — **Serve**
- [ ] `:serve` web page over std's `TcpListener` (`src/serve.ts`, `src/serve-page.ts`) — **Serve**
- [x] demo sessions (`src/demo.ts`, `DemoSession`; `demo.rs`) — **Config**
- [ ] usage float (`:usage`) — **Serve**
