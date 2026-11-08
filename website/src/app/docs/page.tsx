import type { Metadata } from "@farm.js/core";
import type { ReactNode } from "react";
import { Heading, HelpLink, KeyRow, L, Tilde } from "../../components/buffer";
import { Outline, type OutlineSection } from "../../components/outline";
import { Tabline } from "../../components/tabline";
import { VimChrome } from "../../components/vim-chrome";
import { INSTALL, VERSION } from "../../lib/site";

// nothing here reads the request, so it renders once at build time
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "vigent docs",
  description: "The vigent user manual: engines, worktrees and riftri, reviewing and landing work, keys, commands, config and themes.",
};

const INDEX: [string, [string, string][]][] = [
  ["Start", [["start", "getting started"], ["first", "your first agent"]]],
  ["Harness", [["engines", "engines"], ["worktrees", "worktrees"], ["riftri", "riftri"], ["review", "review & land"]]],
  ["Use", [["keys", "keys"], ["commands", "commands"], ["model", "model & effort"]]],
  ["Make it yours", [["config", "config.toml"], ["themes", "themes & icons"]]],
];

/** Every heading on the page, in order, for the outline on the right. */
const OUTLINE: OutlineSection[] = [
  { id: "start", tag: "vigent-start", title: "Getting started" },
  { id: "first", tag: "vigent-first", title: "Your first agent" },
  { id: "engines", tag: "vigent-engines", title: "Engines" },
  { id: "worktrees", tag: "vigent-worktrees", title: "Worktrees" },
  { id: "riftri", tag: "vigent-riftri", title: "riftri" },
  { id: "review", tag: "vigent-review", title: "Review & land" },
  { id: "keys", tag: "vigent-keys", title: "Keys" },
  { id: "commands", tag: "vigent-commands", title: "Commands" },
  { id: "model", tag: "vigent-model", title: "Model & effort" },
  { id: "config", tag: "vigent-config", title: "config.toml" },
  { id: "themes", tag: "vigent-themes", title: "Themes & icons" },
];

const QUICK_KEYS: [string, string][] = [
  ["i", "prompt the agent"],
  ["Esc", "back to NORMAL"],
  [":new", "another agent"],
  [":engine", "pick the engine"],
  [":diff", "see its changes"],
  [":merge", "land it, squashed"],
  [":pr", "open a pull request"],
  ["<Space>", "which-key"],
  ["?", "every key"],
];

/** A code block inside the buffer. */
function Code({ children }: { children: ReactNode }) {
  return (
    <div className="l">
      <pre className="t code">{children}</pre>
    </div>
  );
}

const C = ({ children }: { children: ReactNode }) => <span className="cm">{children}</span>;
const K = ({ children }: { children: ReactNode }) => <span className="kw">{children}</span>;
const S = ({ children }: { children: ReactNode }) => <span className="str">{children}</span>;

export default function DocsPage() {
  return (
    <>
      <Tabline active="docs" />
      <div className="docs">
        <nav className="side" aria-label="Docs">
          <div className="head">" help index</div>
          {INDEX.map(([group, items]) => (
            <div key={group}>
              <div className="grp">{group}</div>
              {items.map(([id, label]) => (
                <a key={id} href={`#${id}`}>
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="buffer">
          <L className="row">
            <span>
              <span className="tag">*vigent-docs*</span> <C>vigent user manual</C>
            </span>
            <C>v{VERSION}</C>
          </L>
          <L />

          <Heading id="start" title="GETTING STARTED" tag="vigent-start" />
          <L>Install globally, then run it inside a git repository.</L>
          <Code>
            <S>{INSTALL}</S>
            {"\n"}
            <S>vigent .</S>
            {"                  "}
            <C># or: vigent ~/code/app</C>
            {"\n"}
            <S>vigent --version</S>
          </Code>
          <L>
            vigent opens on a dashboard: <K>i</K> new agent, <K>E</K> engine, <K>m</K> model, <K>t</K> theme, <K>s</K> settings, <K>?</K> every key. Press{" "}
            <K>&lt;Space&gt;</K> and pause for a which-key panel.
          </L>
          <L />

          <Heading id="first" title="YOUR FIRST AGENT" tag="vigent-first" />
          <L>
            Press <K>i</K>, type what you want done, Enter. The agent starts in its own worktree on a branch named from the task (<S>fix/…</S>, <S>feat/…</S>).
            Press <K>i</K> again to follow up, <K>Esc</K> to go back to NORMAL. Start more with <HelpLink>:new</HelpLink>.
          </L>
          <L />

          <Heading id="engines" title="ENGINES" tag="vigent-engines" />
          <L>
            An engine is what runs an agent. CLIs run as installed, in the agent's worktree, with their own login. The sidebar shows <S>●</S> ready,{" "}
            <K>◐</K> not signed in, <C>○</C> not installed.
          </L>
          <Code>
            <K>:engine</K>
            {"                   "}
            <C>" menu: auto, pi, claude, codex, opencode</C>
            {"\n"}
            <K>:engine</K>
            {" claude            "}
            <C>" new agents run on Claude Code</C>
            {"\n"}
            <K>:new</K>
            {" docs pass --engine codex\n"}
            <K>:checkhealth</K>
            {"              "}
            <C>" what's installed and signed in</C>
          </Code>
          <L>
            Agents keep the engine they started on. <span className="b">auto</span> picks the first signed-in CLI, otherwise pi when it has a key.
          </L>
          <L />

          <Heading id="worktrees" title="WORKTREES" tag="vigent-worktrees" />
          <L>Every agent gets its own worktree and branch, so agents never touch your checkout or each other's files.</L>
          <Code>
            <K>:new</K>
            {" fix flaky checkout test  "}
            <C>" branch fix/flaky-checkout-test</C>
            {"\n"}
            <K>:worktrees</K>
            {"                     "}
            <C>" list them</C>
            {"\n"}
            <K>:kill</K>
            {"                          "}
            <C>" stop the agent, keep its work</C>
            {"\n"}
            <K>:kill!</K>
            {"                         "}
            <C>" also remove the worktree, safely</C>
            {"\n"}
            <K>:attach</K>
            {" <branch>               "}
            <C>" reopen an agent in a kept worktree</C>
          </Code>
          <L>Agents and their conversations come back after a restart. Their records live in git's own worktree metadata, not in your files.</L>
          <L />

          <Heading id="riftri" title="RIFTRI" tag="vigent-riftri" />
          <L>
            <a className="link" href="https://riftri.dev">
              riftri
            </a>{" "}
            installs with vigent. It makes each worktree a real git linked worktree whose unchanged files share copy-on-write storage: APFS clones on macOS,
            Btrfs, reflink XFS or OverlayFS on Linux, ReFS on Windows.
          </L>
          <L />
          <KeyRow k=":new">
            says <S>· riftri apfs-clone</S> (or reflink, overlay-fs…)
          </KeyRow>
          <KeyRow k=":checkhealth">shows why riftri fell back to git, and the fix</KeyRow>
          <KeyRow k="riftri gc">frees storage no worktree uses any more</KeyRow>
          <L />
          <L>
            vigent falls back to plain git only when riftri declines and says nothing changed. <K>[worktree]</K> backend = <S>"riftri"</S> requires it,{" "}
            <S>"git"</S> turns it off.
          </L>
          <L />

          <Heading id="review" title="REVIEW & LAND" tag="vigent-review" />
          <Code>
            <K>:diff</K>
            {"                  "}
            <C>" the agent's changes; ]c / [c between hunks</C>
            {"\n"}
            <K>:diff</K>
            {" split            "}
            <C>" side by side</C>
            {"\n"}
            <K>:merge</K>
            {"                 "}
            <C>" squash into your branch: one commit</C>
            {"\n"}
            <K>:merge</K>
            {" --no-squash     "}
            <C>" a regular merge commit</C>
            {"\n"}
            <K>:pr</K>
            {"                    "}
            <C>" push and open a pull request</C>
            {"\n"}
            <K>:dash</K>
            {"                  "}
            <C>" every agent at a glance</C>
            {"\n"}
            <K>:tree</K>
            {"                  "}
            <C>" go back to any point in the conversation</C>
          </Code>
          <L>A merge only touches your checkout when it's clean and on the agent's base branch. A conflict is rolled back, so nothing changes.</L>
          <L />

          <Heading id="keys" title="KEYS" tag="vigent-keys" />
          <KeyRow k="i  a  o">type a prompt for the focused agent</KeyRow>
          <KeyRow k="j k gg G">scroll the transcript</KeyRow>
          <KeyRow k="{  }">jump between messages</KeyRow>
          <KeyRow k="]s [s 1–9">switch agents</KeyRow>
          <KeyRow k="za zR zM">fold tool output</KeyRow>
          <KeyRow k="V  v">
            select lines, <K>y</K> to copy
          </KeyRow>
          <KeyRow k="yy  yib">copy the last reply / a code block</KeyRow>
          <KeyRow k="dd">kill the focused agent (asks first)</KeyRow>
          <KeyRow k="<Space>…">n d m p q t D u s E M e (pause to see them)</KeyRow>
          <L>Copies go through the terminal (OSC 52), so they work over SSH.</L>
          <L />

          <Heading id="commands" title="COMMANDS" tag="vigent-commands" />
          <Code>
            <K>:new</K>
            {" <task>     "}
            <K>:queue</K>
            {" <prompt>   "}
            <K>:pause</K> <K>:resume</K>
            {"   "}
            <K>:w</K>
            {" [file]\n"}
            <K>:engine</K>
            {"         "}
            <K>:model</K>
            {"           "}
            <K>:effort</K>
            {"          "}
            <K>:settings</K>
            {"\n"}
            <K>:colorscheme</K>
            {"    "}
            <K>:hi</K>
            {" Group …       "}
            <K>:set</K>
            {" transparent  "}
            <K>:help</K>
            {"\n"}
            <K>:nmap</K> <K>:imap</K> <K>:unmap</K> <K>:let</K>
            {" mapleader      "}
            <K>:q</K> <K>:q!</K>
          </Code>
          <L />

          <Heading id="model" title="MODEL & EFFORT" tag="vigent-model" />
          <L>
            <HelpLink>:model</HelpLink> (<K>&lt;Space&gt;M</K>) lists what the agent's engine offers: Claude Code's model names, Codex's own catalog, OpenCode's
            providers. <HelpLink>:effort</HelpLink> (<K>&lt;Space&gt;e</K>) sets reasoning effort. Both apply from the next prompt and survive a restart. In every
            menu: <K>j</K>/<K>k</K> move, Enter picks, <K>q</K> closes, <K>/</K> searches.
          </L>
          <L />

          <Heading id="config" title="CONFIG.TOML" tag="vigent-config" />
          <L>
            <S>~/.config/vigent/config.toml</S>. <K>vigent config init</K> writes a starter file.
          </L>
          <Code>
            <K>theme</K> = <S>"nvim"</S>
            {"\n"}
            <K>engine</K> = <S>"claude"</S>
            {"\n"}
            <K>leader</K> = <S>"&lt;Space&gt;"</S>
            {"\n\n"}
            <C>[ui]</C>
            {"\n"}
            <K>icons</K> = <S>"nerd"</S>
            {"\n\n"}
            <C>[keys.normal]</C>
            {"\n"}
            <S>"&lt;leader&gt;n"</S> = <S>":new "</S>
            {"\n"}
            <S>"&lt;Tab&gt;"</S> = <S>"session.next"</S>
            {"\n\n"}
            <C>[keys.insert]</C>
            {"\n"}
            <S>"jk"</S> = <S>"&lt;Esc&gt;"</S>
          </Code>
          <L>
            <K>vigent config check</K> validates it. <HelpLink>:settings</HelpLink> edits it live; <K>w</K> saves.
          </L>
          <L />

          <Heading id="themes" title="THEMES & ICONS" tag="vigent-themes" />
          <Code>
            <S>vigent theme import</S>
            {"             "}
            <C># the colorscheme your nvim/vim uses</C>
            {"\n"}
            <S>vigent theme import kanagawa</S>
            {"    "}
            <C># any colorscheme your editor can load</C>
            {"\n"}
            <S>vigent theme new mine --from nord</S>
            {"\n"}
            <S>vigent --theme nvim</S>
            {"             "}
            <C># follow Neovim</C>
          </Code>
          <L>
            <HelpLink>:colorscheme</HelpLink> previews live. <K>icons = "nerd"</K> uses Nerd Font icons; set a Nerd Font in your terminal for them.
          </L>
          <L />
          <L className="cm">vim:tw=78:ts=8:ft=help:norl:</L>
          <Tilde count={2} />
        </main>
        <Outline sections={OUTLINE} keys={QUICK_KEYS} />
      </div>
      <VimChrome file="doc/vigent.txt" />
    </>
  );
}
