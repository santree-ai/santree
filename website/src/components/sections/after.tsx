import type { ReactNode } from "react";
import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import { Logo } from "~/components/logo";

const REPO = "https://github.com/santree-ai/santree";

/** What santree touches. Each line is checked against the app: COMPLIANCE.md
 * for the agent credential rules, `claude_usage.rs` for the one documented read. */
const FACTS = [
  {
    term: "Prompts",
    body: "Every workflow's prompt is a template you can read and edit in Settings, per repo or for yourself. Commit one to .santree/prompts and the whole team gets it on the next pull.",
  },
  {
    term: "Your code",
    body: "Worktrees, terminals and diffs live on your disk. There is no santree account and no santree server.",
  },
  {
    term: "Agent logins",
    body: "santree never stores or proxies an agent's login. The one read is Claude Code's own token, sent only to api.anthropic.com to fill the usage meter.",
  },
  {
    term: "Tokens",
    body: "Linear and Jira tokens sit in the OS keychain. GitHub access is borrowed from the gh CLI you're already signed into.",
  },
  {
    term: "Publishing",
    body: "An AI review's draft comments stay on your machine until you publish them. Nothing an agent writes reaches GitHub without your click.",
  },
  {
    term: "Network",
    body: "The integrations you connect, your agent CLI, and an update check against GitHub releases.",
  },
];

export function LocalFirst() {
  return (
    <section id="local" className="relative border-t border-hairline">
      <div className="mx-auto max-w-[1360px] px-6 pb-24 pt-28 sm:px-10 lg:px-14">
        <h2 className="font-display max-w-[16ch] text-balance text-[clamp(2.4rem,1.5rem+3.4vw,4.4rem)] leading-[1.02] tracking-[-0.02em]">
          Your repo never leaves your machine.
        </h2>
        <dl className="mt-16 grid gap-x-8 border-t border-hairline sm:grid-cols-2 lg:grid-cols-3">
          {FACTS.map((f) => (
            <div key={f.term} className="border-b border-hairline py-6 lg:pr-6">
              <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-2">
                {f.term}
              </dt>
              <dd className="mt-3 text-pretty text-[14.5px] leading-relaxed text-[#bfc1c7]">
                {f.body}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "Do I still write prompts?",
    a: "Not to start the work. Run, Investigate and Start work each write the agent's opening prompt from the ticket or the review. You can type into any agent's terminal while it runs, and change any template in Settings.",
  },
  {
    q: "What does it cost?",
    a: "Nothing. santree is free and MIT licensed, with no account to create. Your agents run on your own Claude Code or Codex account, the same as they do in a terminal.",
  },
  {
    q: "Which platforms does it run on?",
    a: (
      <>
        macOS, kept up to date on the stable or beta channel. On Linux it{" "}
        <a className="faq-link" href={`${REPO}#building-from-source`}>
          builds from source
        </a>
        ; there are no packaged Linux builds yet. Windows isn't supported.
      </>
    ),
  },
  {
    q: "Which agents can it drive?",
    a: "Codex and Claude Code: the real CLIs, unmodified, in a real terminal. Settings picks a provider and model per workflow, so triage, work and reviews can each use a different one.",
  },
  {
    q: "Do I need Linear?",
    a: "No. Tickets and Triage read Linear or Jira Cloud, chosen per project. Without either, Trees still works on any git repo, and Reviews needs only the gh CLI.",
  },
  {
    q: "Where do I start?",
    a: (
      <>
        Install it, add a repo, and press Run on a ticket. The{" "}
        <a className="faq-link" href="/docs">
          docs
        </a>{" "}
        cover connecting your tools and every keyboard shortcut.
      </>
    ),
  },
];

/** The questions people ask before downloading, all open: a two-column page
 * of questions and answers, so every answer is in the prerendered HTML. */
export function Questions() {
  return (
    <section id="faq" className="scroll-mt-14 border-t border-hairline">
      <div className="mx-auto max-w-[1360px] px-6 py-24 sm:px-10 lg:px-14">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">
          Before you download
        </p>
        <div className="mt-10 grid gap-x-20 gap-y-12 md:grid-cols-2">
          {QUESTIONS.map((item) => (
            <div key={item.q}>
              <h3 className="font-display text-[1.6rem] leading-[1.15] tracking-[-0.01em]">
                {item.q}
              </h3>
              <p className="mt-3 max-w-[34rem] text-pretty text-[15px] leading-relaxed text-muted">
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section id="download" className="scroll-mt-14 border-t border-hairline">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-10 px-6 py-24 sm:px-10 md:flex-row md:items-end md:justify-between lg:px-14">
        <div>
          <Logo size={30} />
          <h2 className="font-display mt-8 text-[clamp(2.4rem,1.5rem+3vw,4rem)] leading-[1.02] tracking-[-0.02em]">
            All branches merge eventually.
          </h2>
          <p className="mt-4 max-w-md text-pretty text-[15px] leading-relaxed text-muted">
            Point santree at a repo and run your first ticket.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DownloadButton size="lg" />
          <a href={REPO} className="btn btn-ghost h-11 px-5">
            <GitHubLogo size={15} />
            Source
          </a>
        </div>
      </div>
    </section>
  );
}
