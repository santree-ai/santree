import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** The docs: one prerendered page, a sticky section rail beside short, honest
 * sections. Deliberately not deep: each section says what a thing is, how to
 * reach it, and the one or two facts you'd otherwise have to discover. Depth
 * stays in the app (⌘/ lists every shortcut; Settings explains itself) and
 * in the repo for contributors. */

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  head: () => ({
    meta: [
      { title: "santree docs" },
      {
        name: "description",
        content:
          "How to install santree, connect Linear and GitHub, and run Codex and Claude Code across your backlog in parallel git worktrees.",
      },
    ],
  }),
});

const SECTIONS = [
  { id: "getting-started", label: "Getting started" },
  { id: "connect", label: "Connect your tools" },
  { id: "sidebar", label: "The sidebar" },
  { id: "tickets", label: "Tickets" },
  { id: "trees", label: "Trees" },
  { id: "pull-requests", label: "Your pull request" },
  { id: "reviews", label: "Reviews" },
  { id: "triage", label: "Triage" },
  { id: "settings", label: "Settings" },
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
      { label: "Command palette: anything, anywhere", keys: ["⌘", "K"] },
      { label: "Keyboard shortcuts overlay", keys: ["⌘", "/"] },
      { label: "Settings", keys: ["⌘", ","] },
      { label: "Toggle the sidebar", keys: ["⌘", "B"] },
      { label: "Toggle the view's right panel", keys: ["⌘", "L"] },
      { label: "New tab in the workspace", keys: ["⌘", "T"] },
      { label: "Refresh Linear and GitHub data", keys: ["⌘", "⇧", "R"] },
      { label: "Go to Tickets", keys: ["⌘", "1"] },
    ],
  },
  {
    group: "Tickets",
    rows: [
      { label: "Add a ticket to the launch queue", keys: ["⌘", "Click"] },
      { label: "Actionable tickets only", keys: ["⌘", "⇧", "."] },
    ],
  },
  {
    group: "Triage",
    rows: [
      { label: "Next / previous ticket", keys: ["J", "K"] },
      { label: "Investigate the ticket", keys: ["⌘", "I"] },
      { label: "Open the ticket in Linear", keys: ["⌘", "O"] },
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
              . It&rsquo;s a signed, notarized DMG. It keeps itself up to date after that. Prefer to
              see the machinery?{" "}
              <a
                className="text-fg underline decoration-line-2 underline-offset-2 hover:decoration-fg"
                href="https://github.com/santree-ai/santree#building-from-source"
              >
                Build from source
              </a>{" "}
              instead.
            </p>
            <H3>First launch</H3>
            <p>
              santree asks you to <B>add a project</B>: pick any folder inside a git checkout. It
              appears in the sidebar with its own checkout as the first row, and the views light up
              as you connect things. Add more projects any time from the <B>+</B> beside{" "}
              <B>Projects</B>; every setting can be overridden per project.
            </p>
            <H3>What you need</H3>
            <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-4">
              <li>
                <B>git</B>. Worktrees, diffs, and branches are real git.
              </li>
              <li>
                At least one coding agent: <B>Codex</B> or <B>Claude Code</B>, installed and logged
                in. santree drives the CLI you already have, on your existing subscription. It never
                reads or stores either CLI&rsquo;s credentials.
              </li>
              <li>
                <B>GitHub CLI</B> (<Code>gh</Code>), signed in. Optional; it powers Reviews, the PR
                panes and the checks.
              </li>
              <li>
                A <B>Linear</B> workspace. Optional; it powers Tickets and Triage.
              </li>
            </ul>
            <p>
              Nothing is required up front: without a connection a view shows its real, empty state.
              There is no sample data anywhere in santree.
            </p>
          </Section>

          <Section id="connect" title="Connect your tools">
            <H3>Linear</H3>
            <p>
              <B>Settings → General → Linear → Connect.</B> You authorize in the browser; the token
              is stored in the OS keychain, never in plaintext. If you belong to several workspaces,
              each project picks which one it reads from.
            </p>
            <H3>GitHub</H3>
            <p>
              Run <Code>gh auth login</Code> in any terminal and santree picks it up. Prefer not to
              install <Code>gh</Code>? Paste a personal access token instead. It also lives in the
              keychain.
            </p>
            <H3>Agents</H3>
            <p>
              <B>Settings → General</B> shows Claude Code and Codex side by side: whether each is
              installed, logged in, and up to date. The <B>Triage</B>, <B>Work</B> and{" "}
              <B>Reviews</B> tabs pick a provider, a model, an effort and a permission mode per
              workflow, so an investigation can run on one agent and the work on another. A worktree
              can hold sessions from both.
            </p>
            <H3>Environment</H3>
            <p>
              <B>Settings → Environment</B> holds variables (or <Code>.env</Code> file references)
              injected into every terminal santree spawns, app-wide, with per-project overrides. A
              project&rsquo;s <Code>.santree/init.sh</Code> runs when a worktree is created, so a
              fresh checkout arrives with its dependencies installed.
            </p>
          </Section>

          <Section id="sidebar" title="The sidebar">
            <p>
              The sidebar is the app&rsquo;s index and it never leaves. Top to bottom: <B>Search</B>{" "}
              (<Keys keys={["⌘", "K"]} />, the one search across tickets, worktrees, PRs and
              destinations), <B>Tickets</B>, the <B>Triage</B> section, then every project with its
              pull requests waiting on you, its own checkout, and its worktrees grouped the way
              Linear groups them: project, then milestone.
            </p>
            <p>
              Under each worktree sit the agents running in it, and every one carries a dot:{" "}
              <B>working</B>, <B>just finished</B>, or <B>needs you</B>, which is a permission
              prompt or a question you haven&rsquo;t answered. The status bar counts them across
              every project. A project&rsquo;s header and a worktree&rsquo;s row roll the most
              urgent dot up, so a red dot on a folded section is a reason to open it.
            </p>
            <p>
              A worktree&rsquo;s Linear and GitHub marks open the ticket and the pull request as
              tabs. Right-click a worktree, a ticket or a pull request for everything you can do to
              it, including deleting the tree once it has merged.
            </p>
          </Section>

          <Section id="tickets" title="Tickets">
            <p>
              Your Linear queue, as a list grouped by project and milestone or as the dependency
              graph it is. Each row carries the ticket&rsquo;s priority, status, cycle, estimate,
              due date and assignee, and one thing more: <B>Ready</B> when nothing blocks it, or the
              ticket that does. A ticket already started shows its worktree and its pull request.
            </p>
            <p>
              <B>Run</B> starts a ticket: a new worktree, the agent configured for Work, and the
              ticket&rsquo;s prompt already typed. <Keys keys={["⌘", "Click"]} /> queues tickets
              instead; the <B>Queue</B> pane in the right panel holds them with a per-ticket agent
              pick and notes, and <B>Launch</B> starts them all. A blocked ticket can chain its
              branch off its blocker&rsquo;s, so stacked work stays stacked. When more than one
              project shares a ticket&rsquo;s workspace, the first start asks which one and offers
              to remember it (<B>Settings → Work</B>).
            </p>
          </Section>

          <Section id="trees" title="Trees">
            <p>
              Trees is where you&rsquo;ll spend most of your time. Every task lives in its own{" "}
              <B>git worktree</B>, so five agents can run at once and never step on each
              other&rsquo;s diff, and your own checkout stays clean. Pick a worktree in the sidebar
              and its workspace fills the window.
            </p>
            <p>
              The main area is a tab strip: one tab per agent or shell the worktree has open, plus
              whatever you expand into it. <Keys keys={["⌘", "T"]} /> opens another Claude, Codex or
              terminal. Every terminal is a real PTY running the real CLI: interrupt it, answer it,
              run <Code>vim</Code> in it. Tabs survive a restart, and closing one ends its process.
            </p>
            <p>
              The right panel (<Keys keys={["⌘", "L"]} />) is reference beside the work: the{" "}
              <B>ticket</B>, the <B>files</B>, the branch&rsquo;s <B>changes</B> with staging and a
              commit box that can draft the message, and <B>session history</B>, where any past
              conversation resumes in a new tab, with what it cost. Once the branch has a pull
              request, two more panes appear: the PR and its work queue.
            </p>
          </Section>

          <Section id="pull-requests" title="Your pull request">
            <p>
              A PR you opened is worked on next to its worktree, not in the review inbox.{" "}
              <B>Create PR</B> sits above the changes and can draft the title and body from the
              branch. The <B>PR</B> pane shows its state, checks and conversation, and expands into
              the full page: Conversation, Commits, Checks with their logs, Files changed.
            </p>
            <p>
              The <B>AI work</B> pane is the queue. A failing check, a reviewer&rsquo;s comment, a
              draft from an AI review, or a line you flag in the diff each land in it as one item.{" "}
              <B>Start work</B> hands the open items to an agent in a new tab, with a prompt you can
              edit in <B>Settings → Prompts</B>.
            </p>
          </Section>

          <Section id="reviews" title="Reviews">
            <p>
              Reviews is the inbox: other people&rsquo;s pull requests, per project, ordered by what
              needs you. Each project&rsquo;s <B>Reviews</B> row in the sidebar lists what was asked
              of you and what was asked of your teams; the number on it is what you haven&rsquo;t
              answered since the author last pushed.
            </p>
            <p>
              The <B>Pull Request</B> tab is the whole PR: the description and comments, the
              commits, the checks with logs inline, and the files with review threads anchored to
              GitHub&rsquo;s own diff. <B>Review with AI</B> checks the branch out into a worktree
              and starts an agent that writes a <B>brief</B> (what changed, in what order to read
              it, what to watch out for) and <B>draft comments</B> on the diff. Drafts stay on your
              machine; you edit them, drop them, and publish the ones you keep into your pending
              review. Nothing an agent writes reaches GitHub without your click.
            </p>
          </Section>

          <Section id="triage" title="Triage">
            <p>
              Your team&rsquo;s triage queue lives in the sidebar: who is on rotation and until
              when, the tickets waiting with their SLA clock, soonest first, and a folded{" "}
              <B>Snoozed</B> group. <B>Mine / All</B> on the section&rsquo;s title switches between
              your tickets and the whole team&rsquo;s. Right-click a ticket to snooze it.
            </p>
            <p>
              Opening a ticket gives it a workspace: the <B>Linear</B> tab with the ticket and its
              discussion, one tab per <B>Investigate</B> agent (<Keys keys={["⌘", "I"]} />
              ), and a shell. Investigations run on a project you attach to the ticket, on that
              project&rsquo;s main checkout; no worktree is created. The first thing that needs one
              asks which project, with a default you can set in <B>Settings → Triage</B>.
            </p>
          </Section>

          <Section id="settings" title="Settings">
            <p>
              <Keys keys={["⌘", ","]} /> opens Settings as a page. <B>General</B> has the theme,
              updates, and the Linear, GitHub, Claude Code and Codex connections. <B>Triage</B>,{" "}
              <B>Work</B> and <B>Reviews</B> each pick an agent, a model, an effort and a permission
              mode. <B>Prompts</B> holds every prompt a launch renders (the investigation, the work
              prompt, the AI review, the work queue) as Jinja templates you can edit and preview
              against a real ticket. <B>Environment</B>, <B>Terminal</B> and <B>Usage</B> round it
              out. Each setting is app-wide with a per-project override.
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
              santree updates itself. <B>Settings → General → Updates</B> shows your version, checks
              on demand, and picks the release channel: <B>Stable</B> (the default) or <B>Beta</B>,
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
                <B>Nothing an agent writes reaches GitHub without a click.</B> An AI review&rsquo;s
                drafts are rows on your machine until you publish them into your own pending review.
              </li>
              <li>
                <B>Integration tokens live in the OS keychain</B>, Linear OAuth and GitHub tokens
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
              connection means no tickets; no <Code>gh</Code> auth means no reviews. Connect the
              tool and refresh (<Keys keys={["⌘", "⇧", "R"]} />
              ).
            </p>
            <H3>An agent shows as idle while it&rsquo;s clearly working</H3>
            <p>
              The dot comes from the agent&rsquo;s own hooks, which santree adds to every launch. An
              agent started outside santree, or a Codex tab that hasn&rsquo;t been prompted yet,
              reports nothing until its first turn; the sidebar then reads the process itself. If a
              hook write failed, the reason is in{" "}
              <Code>~/Library/Application Support/com.santree.desktop/santree-hook-errors.log</Code>
              .
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
