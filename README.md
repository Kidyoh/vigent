# vigent

A vim-native orchestrator for coding-agent harnesses. Claude Code, Codex, OpenCode, Gemini CLI, Cursor CLI and [pi](https://github.com/badlogic/pi-mono) are harnesses: each runs its own agent loop (the model calls, the tools, the permissions) with its own login. vigent runs the ones you already have side by side, each in its own git worktree, and gives you one vim-native screen to watch them, steer them and land their work. It bundles none of them and never reads their credentials.

**Website:** [vigent.farming-labs.dev](https://vigent.farming-labs.dev) · **Docs:** [vigent.farming-labs.dev/docs](https://vigent.farming-labs.dev/docs)

![vigent: a prompt with an @file and a Claude Code agent fixing the bug in its own worktree; Ctrl-w v forks it into a split, :model gives the fork Claude Opus 5.5 and it writes a test; Ctrl-w h/l/k move between windows, Ctrl-w s stacks another fork, :diff split, then a new theme with Space t](https://vigent.farming-labs.dev/showcase.gif)

## Install

```bash
npm install -g @vigent/cli
```

About 5 MB, most of it [riftri](https://riftri.dev)'s binary for lightweight worktrees. Needs Node.js 20+ and git. The command is `vigent`.

On a machine without Node (a fresh VM, a container), install the standalone binary instead. It needs only git:

```bash
curl -fsSL https://raw.githubusercontent.com/farming-labs/vigent/main/install.sh | sh
```

That downloads the build for your machine (Linux x64 and arm64, glibc or musl, and macOS) from the latest release, checks it against the release's `SHA256SUMS`, puts `vigent` and `riftri` in `~/.vigent` and links `vigent` into `~/.local/bin`. It's about 50 MB to download and 100 MB on disk, because the JavaScript runtime is inside. `VIGENT_VERSION=0.9.3` installs that version; run it again to update.

The same binary, other ways:

```bash
brew tap farming-labs/vigent https://github.com/farming-labs/vigent && brew install vigent   # Homebrew, macOS and Linux
docker run --rm -it -v "$PWD:/work" ghcr.io/farming-labs/vigent                              # a container with vigent and git
```

```powershell
irm https://raw.githubusercontent.com/farming-labs/vigent/main/install.ps1 | iex             # Windows (PowerShell)
```

The container has no agent CLIs in it: build your own image `FROM ghcr.io/farming-labs/vigent` and add the ones you use. On macOS the binary isn't signed; installed with `curl` or Homebrew it runs as it is, while one downloaded in a browser has to be allowed in System Settings first.

## Quick start

```bash
vigent                    # in a git repo: new agents use the first agent CLI you're signed in to
vigent --engine codex     # or pick one: claude, codex, opencode, gemini, cursor, pi
vigent --demo             # scripted agents, nothing installed needed
```

Press `i`, type what you want done, and press Enter. An agent starts on it in its own worktree and branch. `i` again sends a follow-up, `Esc` goes back to NORMAL mode, and `:new <task>` starts another agent. Press `Space` and pause to see every key.

## What it does

- **Many agents, one screen.** A sidebar of agents, switch with `<Space>1`–`9` or `]s` / `[s`. Each one gets a bell or desktop notification when it finishes or needs you.
- **A worktree per agent.** Agents never touch your checkout or each other's files. With riftri, worktrees share copy-on-write storage, so ten agents cost about one checkout of disk.
- **Review and land.** `:diff` (or side by side), `:review` to drop hunks you don't want, then `:merge` or `:pr`.
- **Harnesses as installed, orchestrated.** vigent doesn't call models or run tools itself: it starts each harness in its worktree, reads the events it streams (replies, tool calls, usage), and handles everything around the loop: queues, permissions, approvals, restarts, hooks, review and merge. `:checkhealth` shows which harnesses are installed and signed in.
- **Vim all the way.** Modes, `/` search, folds, visual mode, `:set`, `:nmap`, `:command`, a which-key panel, and your Neovim colorscheme.
- **Themes that change the layout.** `nebula` looks like a dressed-up Neovim (a lualine-style statusline, Nerd Font icons); `neon` puts each agent in a card and your prompts in chat bubbles; `zen` keeps it quiet: one row per agent, Nerd Font icons when you have the font. `[style]` mixes any layout and icons with any colors.
- **Follow from your phone.** `:serve` shows an address and an access code.

## Harnesses

vigent calls the harness an agent runs on its *engine*.

| Engine | vigent runs |
|---|---|
| Claude Code | `claude -p --output-format stream-json` |
| Codex | `codex exec --json` |
| OpenCode | `opencode run --format json` |
| Gemini CLI | `gemini --output-format stream-json` |
| Cursor CLI | `cursor-agent --print --output-format stream-json` |
| pi | `pi --mode rpc`, one per agent |

Any other agent CLI that takes a prompt is a few lines of config (recipes for Amp, Copilot CLI, Aider, Goose and Qwen Code are in [docs/config.md](docs/config.md#your-own-engines)):

```toml
[engines.aider]
command = ["aider", "--yes-always", "--message", "{prompt}"]
```

## Everyday commands

```vim
:new fix flaky checkout test     " a new agent on branch fix/flaky-checkout-test
:diff                            " what the focused agent changed
:review                          " go through its changes hunk by hunk, drop what you don't want
:merge                           " squash-merge its branch into yours
:pr                              " push the branch and open a pull request
:dash                            " every agent at a glance
:model  /  :effort               " pick a model or reasoning effort
:permissions                     " what each agent may do without asking (gh, git, web, sandbox, network)
:kill                            " stop the agent, keep its work (:kill! also removes the worktree)
```

Agents survive a restart: start vigent again in the same repo and they come back with their conversations.

## Configuration

`vigent config init` writes a commented `~/.config/vigent/config.toml`, and `vigent config check` validates it. A repository can add its own `.vigent.toml` for the team's theme, templates, keys and hooks. The hooks and anything else that runs commands only run after you `:trust` the file.

```toml
theme = "tokyonight"            # or "nvim": follow your Neovim colorscheme
engine = "claude"

[keys.normal]
"<leader>t" = "theme.picker"

[hooks]
worktree_created = "npm ci"     # set each new worktree up before the agent starts
before_merge = "npm test"       # :merge and :pr only land a passing branch

[commands]
Test = "!npm test"              # :Test runs in the agent's worktree
```

## Docs

- **[Using vigent](docs/guide.md):** engines, worktrees, reviewing, notifications, `:serve`, every key
- **[Configuration](docs/config.md):** every option, engine setting, hook, command and key
- **[Themes](docs/themes.md):** 28 built-in themes, a [Neovim-style setup](docs/themes.md#a-neovim-style-setup) with Nerd Font icons, layout styles (cards or compact sidebar, labeled or bubble messages, your own icons), importing any vim or Neovim colorscheme

## From source

```bash
git clone https://github.com/farming-labs/vigent && cd vigent
npm install
npm test          # build and run the test suite
npm run demo      # scripted agents
```

`npm run build:binary` builds the standalone binary for your machine into `dist-bin/` (it needs [Bun](https://bun.sh)); `node scripts/build-binary.mjs --all` builds every platform. To test one: `VIGENT_BINARY=dist-bin/vigent-linux-x64/vigent node --test test/standalone.test.mjs`.

To release: bump `version` in package.json, merge, and push a matching tag (`git tag v0.4.1 && git push origin v0.4.1`). The Release workflow tests the code and publishes it with the `NPM_TOKEN` secret. The Binaries workflow builds the standalone binaries, checks each on its own platform, attaches them to the GitHub release, then pushes the container image to ghcr.io and commits the new `Formula/vigent.rb`.
