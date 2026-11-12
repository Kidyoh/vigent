# Standalone binaries

How vigent gets onto a machine without Node: the release pipeline for a standalone binary. It's built and checked on every pull request that touches it, and **publishes nothing yet**. The only build today is a stand-in (the TypeScript with Bun's runtime inside, 85–110 MB), and the binary that will ship is the Rust port's ([#168](https://github.com/farming-labs/vigent/issues/168)). Everything after the build is ready for it.

- [What a build hands over](#what-a-build-hands-over)
- [Plugging in the Rust build](#plugging-in-the-rust-build)
- [The pieces](#the-pieces)
- [How people will install it](#how-people-will-install-it)
- [Trying it locally](#trying-it-locally)

## What a build hands over

One folder per target, with the executable in it:

```
dist-bin/vigent-<target>/vigent          vigent.exe on Windows
```

Anything else in the folder ships beside it. The stand-in puts `riftri` there; a build with riftri linked in ships one file, and nothing downstream expects a second.

The targets, as `node scripts/package-binaries.mjs --list` prints them:

| Target | For |
|---|---|
| `linux-x64`, `linux-arm64` | glibc |
| `linux-x64-baseline` | x64 CPUs without AVX2 (`install.sh` picks it from `/proc/cpuinfo`) |
| `linux-x64-musl`, `linux-arm64-musl` | Alpine and other musl systems |
| `darwin-arm64`, `darwin-x64` | macOS |
| `windows-x64` | Windows, including Windows on ARM |

A Rust build doesn't need a separate baseline: build `linux-x64` for a plain x86-64 CPU and either drop the target from `TARGETS` and from `install.sh`, or publish the same binary under both names.

`scripts/package-binaries.mjs` turns those folders into what gets published:

```
dist-bin/vigent-<target>.tar.gz          the folder, with README.md and LICENSE
dist-bin/SHA256SUMS                      one "<sha256>  <archive>" line each
```

## Plugging in the Rust build

1. In `.github/workflows/binaries.yml`, replace the Build job's steps with the Rust build, leaving `dist-bin/vigent-<target>/vigent` for each target, then run `node scripts/package-binaries.mjs`. The job can become a matrix; the later jobs only need the one `binaries` artifact with the archives and `SHA256SUMS`.
2. Add the tag trigger (`push: { tags: ["v*"] }`).
3. Set the repository variable `PUBLISH_BINARIES` to `true`.
4. Delete `scripts/build-binary.mjs`, `src/standalone.ts` (and its three uses, in `version.ts`, `riftri.ts` and `follow.ts`) and `test/standalone-stand-in.test.mjs`: they only serve the stand-in.

The publish jobs also check that `scripts/build-binary.mjs` is gone, so the stand-in can't be released even if the workflow is started by hand on a tag with `PUBLISH_BINARIES` set.

`test/standalone.test.mjs` is the check the binary has to pass. It only runs the binary and imports nothing from `dist/`, so it doesn't matter what built it:

- `--version` prints `vigent <version in package.json>`, and `--help` and `theme list` work
- with no `node` on PATH, started through a symlink, in a real git repository with a stand-in `claude`: an agent runs in its own worktree, and `:checkhealth` finds riftri without one on PATH
- `install.sh` (or `install.ps1`) refuses a download that doesn't match `SHA256SUMS`, installs, and installs again over itself

What that asks of the Rust build, beyond working:

- **the version comes from `package.json`**: read it at build time (or bump `Cargo.toml` with it), since the test compares the two
- **the same screen text**: the pty test waits for what the TypeScript vigent prints (`● Claude Code  default`, `Enter starts an agent on Claude Code`, `▸ Write`, `│ done`, the `:checkhealth` worktree section)
- **`vigent worktree remove <branch> --force`**: the test cleans up with it and doesn't check the result, so without it worktrees are left behind quietly
- **riftri inside**: with `riftri-core` linked in, `:checkhealth` reports riftri as available though no `riftri` file ships

## The pieces

| File | What it does |
|---|---|
| `scripts/package-binaries.mjs` | packs each built target and writes `SHA256SUMS` |
| `install.sh` | macOS and Linux: picks the target (libc, AVX2), checks the download, installs to `~/.vigent`, links `vigent` into `~/.local/bin` |
| `install.ps1` | Windows: the same, into `%LOCALAPPDATA%\vigent`, and adds it to PATH |
| `scripts/homebrew-formula.mjs` | writes `Formula/vigent.rb` from `SHA256SUMS`, so this repository is its own tap |
| `docker/Dockerfile` | the binary with git on debian-slim, for `ghcr.io/farming-labs/vigent` |
| `.github/workflows/binaries.yml` | builds, checks each target on its own platform (musl in Alpine), builds and runs the image; with publishing on, attaches the archives to the release, pushes the image, commits the formula |
| `test/standalone.test.mjs` | the checks above, run with `VIGENT_BINARY=<path>` |
| `scripts/build-binary.mjs`, `src/standalone.ts`, `test/standalone-stand-in.test.mjs` | the stand-in build and its tests, to delete |

The workflow's jobs, in order: **build** → **check** (Linux x64, x64 baseline, arm64, macOS arm64 and macOS x64 under Rosetta on `macos-latest`, Windows), **check-musl** (Alpine, x64 and arm64) and **image** → **release** → **image-push** and **homebrew**. The last three need a tag and `PUBLISH_BINARIES`.

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

## Trying it locally

```bash
npm run build:binary          # the stand-in, for this machine; needs Bun
VIGENT_BINARY=dist-bin/vigent-linux-x64/vigent node --test test/standalone.test.mjs
VIGENT_DOWNLOAD_BASE=file://$PWD/dist-bin VIGENT_INSTALL=/tmp/vigent-try VIGENT_BIN_DIR=/tmp/vigent-try/bin sh install.sh
```
