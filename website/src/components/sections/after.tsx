import type { ReactNode } from "react";
import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";

const REPO = "https://github.com/santree-ai/santree";

/** What santree touches. Each line is checked against the app: COMPLIANCE.md
 * for the agent credential rules, `claude_usage.rs` for the one documented read.
 * No provider is named: /docs#supported is the one place that lists them. */
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
    body: "santree never stores or proxies an agent's login. The one exception is a single read for the usage meter, sent only to that vendor's own API.",
  },
  {
    term: "Tokens",
    body: "Tracker tokens sit in the OS keychain. Code host access is borrowed from the command line tool you are already signed into.",
  },
  {
    term: "Publishing",
    body: "An AI review's draft comments stay on your machine until you publish them. Nothing an agent writes reaches your code host without your click.",
  },
];

export function LocalFirst() {
  return (
    <section id="local" className="sec">
      <div className="sec-in">
        <div>
          <p className="t-label">Privacy</p>
          <h2 className="font-display t-title mt-4 max-w-[14ch]">
            Your repo never leaves your machine.
          </h2>
        </div>
        <dl className="rows">
          {FACTS.map((f) => (
            <div key={f.term}>
              <dt>{f.term}</dt>
              <dd className="t-body">{f.body}</dd>
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
    a: "Nothing. santree is free and MIT licensed, with no account to create. Your agents run on your own agent account, the same as they do in a terminal.",
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
    q: "Which trackers and agents work with it?",
    a: (
      <>
        santree runs the real agent CLIs, unmodified, in a real terminal, and reads tickets from
        your tracker and pull requests from your code host. Settings picks an agent and model per
        workflow. The{" "}
        <a className="faq-link" href="/docs#supported">
          docs
        </a>{" "}
        keep the current list of supported trackers, code hosts and agents.
      </>
    ),
  },
  {
    q: "Do I need a ticket tracker?",
    a: "No. Without one, Trees still works on any git repo, and Reviews needs only the command line tool for your code host.",
  },
];

/** The questions people ask before downloading, all open, so every answer is in the prerendered HTML. */
export function Questions() {
  return (
    <section id="faq" className="sec scroll-mt-14">
      <div className="sec-in">
        <div>
          <p className="t-label">Questions</p>
          <h2 className="font-display t-title mt-4 max-w-[14ch]">Before you download.</h2>
        </div>
        <div className="rows">
          {QUESTIONS.map((item) => (
            <div key={item.q}>
              <h3>{item.q}</h3>
              <p className="t-body">{item.a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section id="download" className="sec scroll-mt-14">
      <div className="closing-in">
        <div>
          <h2 className="closing-title font-display">All branches merge eventually.</h2>
          <p className="t-body mt-4 max-w-md">Point santree at a repo and run your first ticket.</p>
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
