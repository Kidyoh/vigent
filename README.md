# vigent

A vim-native terminal app for running several coding agents at once, each in its own git worktree. It drives the agents you already have installed (Claude Code, Codex, OpenCode, Gemini CLI, Cursor CLI, [pi](https://github.com/badlogic/pi-mono), or any CLI you add) with their own logins, and bundles none of them.

**Website:** [vigent.farming-labs.dev](https://vigent.farming-labs.dev) · **Docs:** [vigent.farming-labs.dev/docs](https://vigent.farming-labs.dev/docs)

![vigent: a prompt with an @file, a Claude Code agent fixing the bug in its own worktree, the diff side by side, then switching themes with Space t and :colorscheme](https://vigent.farming-labs.dev/showcase.gif)

## Install

```bash
npm install -g @vigent/cli
```

About 5 MB, most of it [riftri](https://riftri.dev)'s binary for lightweight worktrees. Needs Node.js 20+ and git. The command is `vigent`.

## Quick start

```bash
vigent                    # in a git repo: new agents use the first agent CLI you're signed in to
vigent --engine codex     # or pick one: claude, codex, opencode, gemini, cursor, pi
vigent --demo             # scripted agents, nothing installed needed
```

Press `i`, type what you want done, and press Enter. An agent starts on it in its own worktree and branch. `i` again sends a follow-up, `Esc` goes back to NORMAL mode, and `:new <task>` starts another agent. Press `Space` and pause to see every key.

## What it does

- **Many agents, one screen.** A sidebar of agents, switch with `1`–`9` or `]s` / `[s`. Each one gets a bell or desktop notification when it finishes or needs you.
- **A worktree per agent.** Agents never touch your checkout or each other's files. With riftri, worktrees share copy-on-write storage, so ten agents cost about one checkout of disk.
- **Review and land.** `:diff` (or side by side), `:review` to drop hunks you don't want, then `:merge` or `:pr`.
- **Your agents, as installed.** Each runs its own loop with its own login; vigent never reads credentials. `:checkhealth` shows what's installed and signed in.
- **Vim all the way.** Modes, `/` search, folds, visual mode, `:set`, `:nmap`, `:command`, a which-key panel, and your Neovim colorscheme.
- **Themes that change the layout.** `neon` puts each agent in a card and your prompts in chat bubbles; `zen` keeps it to one row per agent. `[style]` mixes any layout and icons with any colors.
- **Follow from your phone.** `:serve` shows an address and an access code.

## Engines

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
- **[Themes](docs/themes.md):** 27 built-in themes, layout styles (cards or compact sidebar, labeled or bubble messages, your own icons), importing any vim or Neovim colorscheme

## From source

```bash
git clone https://github.com/farming-labs/vigent && cd vigent
npm install
npm test          # build and run the test suite
npm run demo      # scripted agents
```

To release: bump `version` in package.json, merge, and push a matching tag (`git tag v0.4.1 && git push origin v0.4.1`). The Release workflow tests the code and publishes it with the `NPM_TOKEN` secret.
