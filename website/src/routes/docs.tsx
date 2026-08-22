import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The docs: one prerendered page, Conductor-style — a sticky section rail
 * beside short, honest sections. Deliberately not deep: each section says
 * what a thing is, how to reach it, and the one or two facts you'd
 * otherwise have to discover. Depth stays in the app (⌘/ lists every
 * shortcut; Settings explains itself) and in the repo for contributors. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () => ({
    meta: [
      { title: "santree docs" },
      {
        name: "description",
        content:
          "How to install santree, connect Linear and GitHub, and run Claude agents across your backlog in parallel git worktrees.",
      },
    ],
  }),
});

const SECTIONS = [
  { id: "getting-started", label: "Getting started" },
  { id: "connect", label: "Connect your tools" },
  { id: "triage", label: "Triage" },
  { id: "issues", label: "Issues" },
  { id: "trees", label: "Trees" },
  { id: "reviews", label: "Reviews" },
  { id: "shortcuts", label: "Keyboard shortcuts" },
  { id: "updates", label: "Updates" },
  { id: "privacy", label: "Privacy & security" },
  { id: "troubleshooting", label: "Troubleshooting" },
] as const;

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4em] items-center justify-center rounded-[5px] border border-line-2 bg-white/4 px-1.5 py-px font-mono text-[11px] text-fg/90">
      {children}
    </kbd>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-28 border-b border-hairline py-10 first:pt-0 last:border-b-0"
    >
      <h2 className="text-[22px] font-semibold tracking-[-0.01em]">{title}</h2>
      <div className="mt-4 flex flex-col gap-3.5 text-[14.5px] leading-relaxed text-muted">
        {children}
      </div>
    </section>
  );
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-3 text-[15px] font-semibold text-fg">{children}</h3>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[5px] border border-hairline bg-white/4 px-1.5 py-px font-mono text-[12.5px] text-fg/90">
      {children}
    </code>
  );
}

/** Strong inline term, in foreground so it pops out of the muted body. */
function B({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-fg">{children}</strong>;
}

const SHORTCUTS: { group: string; rows: { label: string; keys: string[] }[] }[] = [
  {
    group: "General",
    rows: [
      { label: "Keyboard shortcuts overlay", keys: ["⌘", "/"] },
      { label: "Settings", keys: ["⌘", ","] },
      { label: "Toggle sidebar", keys: ["⌘", "B"] },
      { label: "Toggle the view's right panel", keys: ["⌘", "L"] },
      { label: "Refresh Linear and GitHub data", keys: ["⌘", "⇧", "R"] },
      { label: "Go to the nth tab", keys: ["⌘", "1–9"] },
    ],
  },
  {
    group: "Triage",
    rows: [
      { label: "Next / previous issue", keys: ["J", "K"] },
      { label: "Investigate issue", keys: ["⌘", "I"] },
      { label: "Open issue in Linear", keys: ["⌘", "O"] },
    ],
  },
  {
    group: "Issues",
    rows: [
      { label: "Add ticket to the launch queue", keys: ["⌘", "Click"] },
      { label: "Actionable tickets only", keys: ["⌘", "⇧", "."] },
    ],
  },
];

function DocsPage() {
  return (
    <main id="main" className="mx-auto max-w-5xl px-6 pb-32 pt-32">
      <div className="lg:grid lg:grid-cols-[190px_1fr] lg:gap-14">
        {/* Section rail */}
        <aside className="mb-10 lg:mb-0">
          <div className="lg:sticky lg:top-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">Docs</p>
            <nav aria-label="Docs sections" className="mt-4">
              <ul className="flex flex-wrap gap-x-4 gap-y-1.5 lg:flex-col lg:gap-y-2">
                {SECTIONS.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="text-[13px] text-muted transition-colors hover:text-fg"
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="mt-8 hidden flex-col gap-2 lg:flex">
              <a
                href="https://github.com/santree-ai/santree"
                className="text-[12.5px] text-muted-2 transition-colors hover:text-fg"
              >
                GitHub →
              </a>
              <Link to="/" className="text-[12.5px] text-muted-2 transition-colors hover:text-fg">
                Home →
              </Link>
            </div>
          </div>
        </aside>

        {/* Content */}
        <div className="min-w-0">
          <header className="border-b border-hairline pb-10">
            <h1 className="text-4xl font-semibold tracking-[-0.02em]">santree docs</h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
              Everything you need to go from a downloaded app to agents shipping tickets. Short on
              purpose. The app explains itself as you go, and <Kbd>⌘</Kbd> <Kbd>/</Kbd> lists every
              shortcut from anywhere.
            </p>
          </header>

          <Section id="getting-started" title="Getting started">
            <p>
              <a
                className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                href="https://github.com/santree-ai/santree/releases/latest/download/santree-macos.dmg"
              >
                Download santree for macOS
              </a>
              . It&rsquo;s a signed, notarized DMG. It keeps itself up to date after that. On Linux,
              santree runs as a native app too, but there are no packaged builds yet:{" "}
              <a
                className="text-fg underline decoration-line-2 underline-offset-2 hover:decoration-fg"
                href="https://github.com/santree-ai/santree#building-from-source"
              >
                build from source
              </a>{" "}
              in a few minutes.
            </p>
            <H3>First launch</H3>
            <p>
              santree asks you to <B>open a repository</B>: pick any folder inside a git checkout.
              That registers the repo and the tabs light up. Add more repos any time from the repo
              switcher at the top of the sidebar; every setting can be overridden per repo.
            </p>
            <H3>What you need</H3>
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-4">
              <li>
                <B>git</B> — worktrees, diffs, and branches are real git.
              </li>
              <li>
                <B>Claude Code</B> installed and logged in. santree drives the CLI you already have,
                on your existing subscription. <B>No API key</B>, and santree never touches the
                CLI&rsquo;s credentials.
              </li>
              <li>
                <B>GitHub CLI</B> (<Code>gh</Code>), signed in. Optional; it powers Reviews and PR
                chips.
              </li>
              <li>
                A <B>Linear</B> workspace. Optional; it powers Triage and the Issues graph.
              </li>
            </ul>
            <p>
              Nothing is required up front: without a connection a view simply shows its real, empty
              state. There is no sample data anywhere in santree.
            </p>
          </Section>

          <Section id="connect" title="Connect your tools">
            <H3>Linear</H3>
            <p>
              <B>Settings → Integrations → Connect.</B> You authorize in the browser; the token is
              stored in the OS keychain, never in plaintext. If you belong to several orgs, each
              repo picks which one it uses.
            </p>
            <H3>GitHub</H3>
            <p>
              Run <Code>gh auth login</Code> in any terminal and santree picks it up. Prefer not to
              install <Code>gh</Code>? Paste a personal access token instead. It also lives in the
              keychain.
            </p>
            <H3>Agents</H3>
            <p>
              <B>Settings → Agents</B> points santree at your Claude Code executable and sets the
              default model. The launch tray and Investigate button read from here; both let you
              override the model per launch.
            </p>
            <H3>Environment</H3>
            <p>
              <B>Settings → Environment</B> holds variables (or <Code>.env</Code> file references)
              injected into every terminal santree spawns — app-wide, with per-repo overrides.
            </p>
          </Section>

          <Section id="triage" title="Triage">
            <p>
              Your team&rsquo;s untriaged Linear inbox, ranked so the queue is workable: priority
              and SLA up top, snoozed tickets dimmed and sunk to the bottom. <B>Mine/All</B>{" "}
              switches between your queue and the whole team&rsquo;s.
            </p>
            <p>
              Reading a ticket is half the job; <B>Investigate</B> (<Keys keys={["⌘", "I"]} />) is
              the other half. It opens a real terminal in the repo with your agent already reading
              the issue. Select several tickets and launch the batch. The status picker promotes an
              issue without leaving the keyboard, and <Kbd>J</Kbd>/<Kbd>K</Kbd> walk the queue.
            </p>
          </Section>

          <Section id="issues" title="Issues">
            <p>
              Tickets are a dependency graph, so santree draws one: blocked-by edges between cards,
              translucent bands grouping each Linear project, and badges for state: <B>RDY</B> when
              nothing blocks a ticket, <B>WIP</B> once a worktree exists for it.
            </p>
            <p>
              Queue tickets from the list or the graph (<Keys keys={["⌘", "Click"]} />, or{" "}
              <B>Select Ready</B> for everything launchable), pick agent and model in the tray, and{" "}
              <B>Launch</B>. Each ticket gets its own worktree and agent, in parallel. A dependent
              ticket can chain its branch off its blocker&rsquo;s, so stacked work stays stacked.
            </p>
          </Section>

          <Section id="trees" title="Trees">
            <p>
              Trees is where you&rsquo;ll spend most of your time. Every task lives in its own{" "}
              <B>git worktree</B>, so five agents can run at once and never step on each
              other&rsquo;s diff, and your own checkout stays clean. Sidebar cards show each
              session&rsquo;s live state: <B>running</B>, <B>delegating</B> to a subagent, or{" "}
              <B>waiting</B> on you.
            </p>
            <p>
              The terminal is a real PTY running the real CLI: interrupt it, answer it, run{" "}
              <Code>vim</Code> in it. The <B>Issue</B> tab keeps the ticket beside the terminal, and{" "}
              <B>Files</B> (<Keys keys={["⌘", "L"]} />) opens the diff and commit panel. From the
              bottom bar you push, open a PR, or pull the base branch through the worktree.
            </p>
            <p>
              When a PR merges, its card dims. <B>Select merged</B> cleans up finished worktrees and
              their branches in one sweep.
            </p>
          </Section>

          <Section id="reviews" title="Reviews">
            <p>
              A pull-request inbox ordered by what you should pick up next: <B>Needs your review</B>{" "}
              first, then team requests, then your own PRs by repo. Rows carry the review decision,
              CI state, and how long a PR has waited.
            </p>
            <p>
              The detail pane is a full review surface: the diff with inline comment threads, the
              linked ticket, and <B>Ask AI</B>, which checks the PR out and opens a Claude session
              beside the code instead of on top of it. The <B>Checks</B> tab shows CI with logs
              inline, and <B>Fix CI with AI</B> hands a failing run straight to an agent.
            </p>
          </Section>

          <Section id="shortcuts" title="Keyboard shortcuts">
            <p>
              The canonical list lives in the app. Press <Keys keys={["⌘", "/"]} /> anywhere. The
              ones worth memorizing:
            </p>
            <div className="mt-1 flex flex-col gap-5">
              {SHORTCUTS.map((g) => (
                <div key={g.group}>
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-4">
                    {g.group}
                  </p>
                  <ul className="flex flex-col">
                    {g.rows.map((row) => (
                      <li
                        key={row.label}
                        className="flex items-center justify-between gap-4 border-b border-hairline py-2 text-[13.5px] last:border-b-0"
                      >
                        <span>{row.label}</span>
                        <Keys keys={row.keys} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>

          <Section id="updates" title="Updates">
            <p>
              santree updates itself. <B>Settings → Updates</B> shows your version, checks on
              demand, and picks the release channel: <B>Stable</B> (the default) or <B>Beta</B>,
              which gets every release as soon as it builds.
            </p>
            <p>
              Updates only move forward. Switching from Beta back to Stable takes effect once a
              stable release passes the beta you&rsquo;re on.
            </p>
          </Section>

          <Section id="privacy" title="Privacy & security">
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-4">
              <li>
                <B>Your code stays on disk.</B> Agents run locally, in worktrees of your repo.
                santree sends nothing anywhere on its own.
              </li>
              <li>
                <B>Your agent&rsquo;s login is its own.</B> santree runs the unmodified CLI in a
                real terminal. It never reads, stores, or proxies the agent&rsquo;s credentials, and
                never drives it unattended.
              </li>
              <li>
                <B>Integration tokens live in the OS keychain</B> — Linear OAuth and GitHub PATs
                alike, never plaintext.
              </li>
              <li>
                The only network traffic is the integrations you connect: Linear for tickets, GitHub
                for PRs, and whatever your agent CLI talks to.
              </li>
            </ul>
            <p>
              The constraints around agent CLIs are written down and load-bearing:{" "}
              <a
                className="text-fg underline decoration-line-2 underline-offset-2 hover:decoration-fg"
                href="https://github.com/santree-ai/santree/blob/main/COMPLIANCE.md"
              >
                COMPLIANCE.md
              </a>
              .
            </p>
          </Section>

          <Section id="troubleshooting" title="Troubleshooting">
            <H3>A view is empty</H3>
            <p>
              That&rsquo;s the real state, not a bug. santree never fabricates data. No Linear
              connection means an empty Triage; no <Code>gh</Code> auth means an empty Reviews.
              Connect the tool and refresh (<Keys keys={["⌘", "⇧", "R"]} />
              ).
            </p>
            <H3>Logs</H3>
            <p>
              Rust and webview logs land in{" "}
              <Code>~/Library/Logs/com.santree.desktop/santree.log</Code> on macOS. Attach the tail
              when filing an issue.
            </p>
            <H3>Something else</H3>
            <p>
              <a
                className="text-fg underline decoration-line-2 underline-offset-2 hover:decoration-fg"
                href="https://github.com/santree-ai/santree/issues"
              >
                Open an issue
              </a>
              . Pre-release means fast-moving, and reports genuinely steer what gets fixed next.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}
