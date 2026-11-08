import type { Metadata } from "@farm.js/core";
import { Heading, HelpLink, KeyRow, L, Rule, Tilde } from "../components/buffer";
import { Screen } from "../components/screen";
import { Tabline } from "../components/tabline";
import { VimChrome } from "../components/vim-chrome";
import { INSTALL, LOGO, SWATCHES } from "../lib/site";

// nothing here reads the request, so it renders once at build time
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "vigent — the vim-native agent harness",
  description:
    "Run Claude Code, Codex, OpenCode and pi in parallel, each in its own copy-on-write worktree powered by riftri, from one Vim-style terminal screen.",
};

export default function HomePage() {
  return (
    <>
      <Tabline active="home" />
      <main className="buffer" id="top">
        <L className="row">
          <span>
            <span className="tag">*vigent.txt*</span> <span className="cm">the vim-native agent harness</span>
          </span>
          <span className="cm">MIT</span>
        </L>
        <L />
        <div className="l">
          <pre className="logo" aria-label="vigent">
            {LOGO}
          </pre>
        </div>
        <L />
        <L className="eyebrow">an agent harness for the terminal</L>
        <div className="l">
          <h1 className="t lede">Run every coding agent at once. Each in its own worktree, all from one Vim-style screen.</h1>
        </div>
        <L />
        <div className="l">
          <p className="t sub">
            vigent drives Claude Code, Codex, OpenCode and pi in parallel. Every agent gets a copy-on-write worktree from{" "}
            <a className="link" href="https://riftri.dev">
              riftri
            </a>
            , so ten agents on a big repo cost almost no disk, and none of them touch your checkout until you <HelpLink href="/docs#review">:merge</HelpLink>.
          </p>
        </div>
        <L />
        <L className="install">
          <code>{INSTALL}</code>
          <button className="yank" type="button" data-yank title="Copy the install command">
            yy
          </button>
          <span className="cm">then</span> <span className="str">vigent .</span>
        </L>
        <L />
        <L className="facts">
          <div className="fact">
            <div className="n">4 engines</div>
            <div className="d">Claude Code · Codex · OpenCode · pi</div>
          </div>
          <div className="fact">
            <div className="n">1 worktree each</div>
            <div className="d">own branch, own files, live +/− counts</div>
          </div>
          <div className="fact">
            <div className="n">copy-on-write</div>
            <div className="d">APFS · Btrfs · XFS · OverlayFS · ReFS</div>
          </div>
        </L>
        <L />
        <div className="l">
          <Screen />
        </div>
        <L />

        <Rule />
        <Heading id="install" title="1. Install" tag="vigent-install" />
        <L />
        <L className="indent">
          <span className="str">{INSTALL}</span> <span className="cm">" Node 20+, macOS, Linux, Windows</span>
        </L>
        <L className="indent">
          <span className="str">cd your-repo &amp;&amp; vigent .</span>
        </L>
        <L />
        <L>
          riftri comes with it. Press <span className="kw">i</span>, type a task, Enter: the first agent starts in its own worktree.{" "}
          <HelpLink href="/docs">vigent-docs</HelpLink> has the rest.
        </L>
        <L />

        <Rule />
        <Heading id="harness" title="2. Worktrees, fast" tag="vigent-riftri" />
        <L />
        <L>
          A plain worktree is a full copy of your checkout. riftri makes each agent's worktree a real git linked worktree whose unchanged files share storage, so a
          new agent costs almost nothing and only the files it changes take space.
        </L>
        <L />
        <div className="l">
          <pre className="t tree" aria-label="Worktree layout">
            {"shop/                         "}
            <span className="cm">your checkout, untouched</span>
            {"\nshop-worktrees/\n├── fix-flaky-test/           "}
            <span className="str">fix/flaky-test</span>
            {"   "}
            <span className="cm">shares unchanged files</span>
            {"\n├── auth-refactor/            "}
            <span className="str">refactor/auth</span>
            {"    "}
            <span className="cm">shares unchanged files</span>
            {"\n└── docs-pass/                "}
            <span className="str">docs/pass</span>
            {"        "}
            <span className="cm">shares unchanged files</span>
          </pre>
        </div>
        <L />
        <L>Agents survive a restart. Removing one goes through git's safety checks, so uncommitted work is never thrown away. Review, then land it:</L>
        <KeyRow k=":diff">what the agent changed, hunk by hunk</KeyRow>
        <KeyRow k=":merge">squash it into your branch as one commit</KeyRow>
        <KeyRow k=":pr">or push the branch and open a pull request</KeyRow>
        <L />

        <Rule />
        <Heading id="engines" title="3. Engines" tag="vigent-engines" />
        <L />
        <L>vigent is the harness. The agents are the ones you already use, with the logins they already have. vigent never reads their credentials.</L>
        <L />
        <KeyRow k="Claude Code">your installed CLI, signed in as usual</KeyRow>
        <KeyRow k="Codex">your installed CLI, with its own model list</KeyRow>
        <KeyRow k="OpenCode">your installed CLI and its providers</KeyRow>
        <KeyRow k="pi">built in, when you'd rather bring an API key</KeyRow>
        <L />
        <L>
          Pick with <HelpLink href="/docs#engines">:engine</HelpLink>, or give one agent its own:
        </L>
        <L className="indent">
          <span className="str">:new fix the flaky test --engine codex</span>
        </L>
        <L />

        <Rule />
        <Heading id="keys" title="4. Keys" tag="vigent-keys" />
        <L />
        <L>If you know Neovim, you already know most of it.</L>
        <L />
        <KeyRow k="i">new agent: type a task, Enter</KeyRow>
        <KeyRow k="]s  [s  1–9">switch agents</KeyRow>
        <KeyRow k="<Space>E">pick the engine</KeyRow>
        <KeyRow k="<Space>M">pick the model</KeyRow>
        <KeyRow k="<Space>e">reasoning effort</KeyRow>
        <KeyRow k="/pattern">search the transcript</KeyRow>
        <KeyRow k="yy  yib">copy the last reply / a code block</KeyRow>
        <KeyRow k="?">every key, yours first</KeyRow>
        <L />

        <Rule />
        <Heading id="themes" title="5. Themes" tag="vigent-themes" />
        <L />
        <L>
          25 colorschemes built in, any Vim or Neovim theme imports, and Nerd Font icons like AstroNvim. Or follow the theme your Neovim config sets:{" "}
          <span className="cm">&gt;</span>
        </L>
        <L className="indent">
          <span className="kw">theme</span> = <span className="str">"nvim"</span>
        </L>
        <L>
          <span className="cm">&lt;</span>
        </L>
        <L className="swatches">
          {SWATCHES.map(([name, colors]) => (
            <span className="sw" key={name}>
              {colors.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
              {name}
            </span>
          ))}
        </L>
        <L />
        <Rule />
        <L className="cm">vim:tw=78:ts=8:ft=help:norl:</L>
        <Tilde />
      </main>
      <VimChrome file="vigent.txt" />
    </>
  );
}
