# Standalone binaries

vigent as one file that needs git and nothing else: no Node. The binary is the Rust port ([#168](https://github.com/farming-labs/vigent/issues/168)) in `crates/vigent`, with riftri linked in, so worktrees are copy-on-write and there's no second file. **Nothing is published yet**: the pipeline builds and checks every platform on each pull request that touches it.

- [What's in it](#whats-in-it)
- [Sizes](#sizes)
- [Building it](#building-it)
- [What a build hands over](#what-a-build-hands-over)
- [The checks](#the-checks)
- [The pieces](#the-pieces)
- [Publishing](#publishing)
- [How people will install it](#how-people-will-install-it)

## What's in it

Milestone 1 of the port, for real work with Claude Code:

- **Agents on Claude Code**, run as installed with its own login: `i`, type a task, Enter starts an agent named after it; follow-ups continue the same conversation (`--resume`), and prompts sent while it works wait their turn.
- **A worktree per agent, made by riftri** (linked in): `../<repo>-worktrees/<branch>`, branch names like `feat/write-hello-file`, made in the background; plain `git worktree` only where riftri can't on that volume, and `:checkhealth` says why.
- **Vim keys**: NORMAL / INSERT / COMMAND, `j`/`k`, `Ctrl-d`/`Ctrl-u`, `gg`/`G`, `]s`/`[s` and `Space 1`–`9` between agents, `:new <task>`, `:kill` / `:kill!`, `:theme <name>`, `:checkhealth`, `:help`, `:q` / `:q!`.
- **The sidebar, statusline and transcript**: each agent's state, branch and `+added −removed`, the model, tokens and cost; replies with headings, lists, code blocks, bold and code spans.
- **All 28 built-in themes**, the same colors as the TypeScript vigent (`crates/vigent/src/themes.txt` is written from `src/builtin-themes.ts` by `scripts/export-themes.mjs`, and `npm test` fails if it's out of date); `theme = "..."` in `config.toml`, or `--theme`.
- **`vigent worktree list` / `remove`**, `vigent theme list`, `--version`, `--help`.

Codex, OpenCode, Gemini CLI, Cursor CLI, pi, restoring agents after a restart, review and merge, races, `:serve` and the rest come in the next milestones (#168); until then the npm package runs all of it.

## Sizes

Linux x64, measured:

| Build | Binary | Download |
|---|---|---|
| Rust (`scripts/build-binary.mjs`), every feature, riftri inside | 2.8 MB | 1.3 MB |
| Rust at milestone 1 (Claude Code engine and worktrees only) | 1.5 MB | 0.7 MB |
| Bun (`scripts/build-binary-bun.mjs`), riftri beside it | 104.5 MB + 4.3 MB | 51.3 MB |

The release profile in `crates/vigent/Cargo.toml` is set for size: `opt-level = "z"` (13% smaller than `"s"`, and the pty suite runs no slower), fat LTO, one codegen unit, `panic = "abort"`, stripped.

## Building it

```bash
npm run build:binary                                   # Rust, for this machine (needs https://rustup.rs)
node scripts/build-binary.mjs linux-x64-musl           # another target: rustup target add x86_64-unknown-linux-musl first
(cd crates/vigent && cargo test)                       # the crate's own tests
```

**The Bun build is optional**: `npm run build:binary:bun` compiles today's TypeScript (every engine) with Bun's runtime inside. It's 85–110 MB, never published, and useful where you want the whole TypeScript vigent without Node, or to run the whole pty suite through a binary. In CI, run the Binaries workflow by hand with **bun** ticked.

## What a build hands over

One folder per target, with the executable in it:

```
dist-bin/vigent-<target>/vigent          vigent.exe on Windows
```

| Target | Rust target | For |
|---|---|---|
| `linux-x64` | `x86_64-unknown-linux-gnu` | glibc |
| `linux-x64-baseline` | the same build | x64 CPUs without AVX2 (Rust's x86-64 doesn't need it; kept so older installers find it) |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | glibc |
| `linux-x64-musl`, `linux-arm64-musl` | `*-unknown-linux-musl` | Alpine and other musl systems (static) |
| `darwin-arm64`, `darwin-x64` | `*-apple-darwin` | macOS |
| `windows-x64` | `x86_64-pc-windows-msvc` | Windows, including Windows on ARM |

`scripts/package-binaries.mjs` turns those folders into what gets published:

```
dist-bin/vigent-<target>.tar.gz          the folder, with README.md and LICENSE
dist-bin/SHA256SUMS                      one "<sha256>  <archive>" line each
```

## The checks

`test/standalone.test.mjs` runs a built binary (`VIGENT_BINARY=<path>`) and imports nothing from `dist/`, so it doesn't matter what built it. The Rust binary passes it:

- `--version` prints `vigent <version in package.json>` (build.rs reads it), and `--help` and `theme list` work
- with no `node` on PATH, started through a symlink, in a real git repository with a stand-in `claude`: an agent runs in its own worktree, and `:checkhealth` finds riftri without one on PATH
- `install.sh` (or `install.ps1`) refuses a download that doesn't match `SHA256SUMS`, installs, and installs again over itself

The rest of the suite is the parity check, the port's finish line: `VIGENT_TTY_BINARY=<binary>` makes every pty test (navigation, config, layout, permissions, worktrees, every engine) drive that binary instead of Node and `dist/`. The Bun build passes all of it, and the workflow runs it for the Bun build; the Rust build takes it over once it has every engine (#168, milestone 5):

```bash
VIGENT_TTY_BINARY=dist-bin/vigent-linux-x64/vigent VIGENT_BINARY=dist-bin/vigent-linux-x64/vigent node --test test/*.test.mjs
```

## The pieces

| File | What it does |
|---|---|
| `crates/vigent` | the Rust vigent |
| `scripts/build-binary.mjs` | builds it for each target into `dist-bin/`, then packs |
| `scripts/build-binary-bun.mjs`, `src/standalone.ts`, `test/standalone-stand-in.test.mjs` | the optional Bun build and its test |
| `scripts/export-themes.mjs` | writes `crates/vigent/src/themes.txt` from the TypeScript themes |
| `scripts/package-binaries.mjs` | packs each built target and writes `SHA256SUMS` |
| `install.sh` | macOS and Linux: picks the target (libc, AVX2), checks the download, installs to `~/.vigent`, links `vigent` into `~/.local/bin` |
| `install.ps1` | Windows: the same, into `%LOCALAPPDATA%\vigent`, and adds it to PATH |
| `scripts/homebrew-formula.mjs` | writes `Formula/vigent.rb` from `SHA256SUMS`, so this repository is its own tap |
| `docker/Dockerfile` | the binary with git on debian-slim, for `ghcr.io/farming-labs/vigent` |
| `.github/workflows/binaries.yml` | builds Rust on each platform's own runner and packs it, checks each target on its own platform (musl in Alpine), builds and runs the image; with publishing on, attaches the archives to the release, pushes the image, commits the formula |

The workflow's jobs, in order: **rust** (one per platform) → **build** (pack) → **check** (Linux x64, x64 baseline, arm64, macOS arm64 and macOS x64 under Rosetta on `macos-latest`, Windows), **check-musl** (Alpine, x64 and arm64) and **image** → **release** → **image-push** and **homebrew**. The last three need a tag and `PUBLISH_BINARIES`, and never run for the Bun build.

## Publishing

To release the Rust binaries with each version:

1. Add the tag trigger to `.github/workflows/binaries.yml`: `push: { tags: ["v*"] }`.
2. Set the repository variable `PUBLISH_BINARIES` to `true`.

## How people will install it

Once a release has binaries (none does yet, so these don't work today):

```bash
curl -fsSL https://raw.githubusercontent.com/farming-labs/vigent/main/install.sh | sh
brew tap farming-labs/vigent https://github.com/farming-labs/vigent && brew install vigent
docker run --rm -it -v "$PWD:/work" ghcr.io/farming-labs/vigent
```

```powershell
irm https://raw.githubusercontent.com/farming-labs/vigent/main/install.ps1 | iex
```

`VIGENT_VERSION=0.9.3` installs that version, and running the installer again updates. The container has no agent CLIs in it: build an image `FROM ghcr.io/farming-labs/vigent` and add the ones you use. The macOS binary isn't signed: installed with `curl` or Homebrew it runs as it is, while one downloaded in a browser has to be allowed in System Settings first.

Still to decide: whether `install.sh` is served from a domain of its own, whether the formula stays in this repository or moves to a tap (the homebrew job pushes to the default branch, which a protected branch refuses), and signing for macOS.

To try a build locally:

```bash
npm run build:binary
VIGENT_BINARY=dist-bin/vigent-linux-x64/vigent node --test test/standalone.test.mjs
VIGENT_DOWNLOAD_BASE=file://$PWD/dist-bin VIGENT_INSTALL=/tmp/vigent-try VIGENT_BIN_DIR=/tmp/vigent-try/bin sh install.sh
```
