import type { ReactNode } from "react";
import { FadeUp } from "~/components/motion/fade-up";

/** The questions people ask before downloading. Native <details>, so it works
 * without JS and every answer is in the prerendered HTML. */

const REPO = "https://github.com/santree-ai/santree";

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "What does it cost?",
    a: "Nothing. santree is free and MIT licensed, with no account to create. Your agents run on your own Claude Code or Codex account, the same as they do in a terminal.",
  },
  {
    q: "Which platforms does it run on?",
    a: (
      <>
        macOS, as a signed and notarized download that keeps itself up to date on the stable or beta
        channel. On Linux it{" "}
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

function Plus() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-20 py-28">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-12 px-6 lg:grid-cols-[5fr_7fr] lg:gap-20">
        <FadeUp>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">FAQ</p>
          <h2 className="mt-4 text-balance text-[clamp(2rem,1.4rem+2.4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.02em]">
            Before you download.
          </h2>
        </FadeUp>
        <FadeUp delay={0.06}>
          <div>
            {QUESTIONS.map((item) => (
              <details key={item.q} className="faq-item group">
                <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-[16px] font-medium transition-colors hover:text-white">
                  {item.q}
                  <span className="faq-icon shrink-0 text-muted-2">
                    <Plus />
                  </span>
                </summary>
                <p className="-mt-1 max-w-xl pb-6 text-pretty text-[15px] leading-relaxed text-muted">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </FadeUp>
      </div>
    </section>
  );
}
