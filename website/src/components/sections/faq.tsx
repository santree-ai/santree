import { FadeUp } from "~/components/motion/fade-up";
import { SectionHeading } from "~/components/ui/section-heading";

/** FAQ on native <details>/<summary> — SSR-complete, indexed, works with
 * JS disabled. The open/close ease and marker rotation are pure CSS. */

const FAQS = [
  {
    q: "Can I use santree today?",
    a: "Yes. Download the macOS app — a signed, notarized DMG that keeps itself up to date. On Linux there are no packaged builds yet, but building from source takes a few minutes.",
  },
  {
    q: "Do I need an API key?",
    a: "No. santree drives the Claude Code CLI you already have, with your existing login and subscription. It never reads, stores, or proxies an agent's credentials. You authenticate in the terminal, exactly as you would without santree.",
  },
  {
    q: "Is my code sent anywhere?",
    a: "Not by santree. Your repo stays on disk and agents run locally in git worktrees. The only network traffic is what you connect yourself: Linear for tickets, GitHub for PRs, and whatever your agent CLI talks to.",
  },
  {
    q: "How is this different from Claude Code in a bunch of tmux panes?",
    a: "Isolation and oversight. Every agent gets its own git worktree, so five agents can't step on one diff. Around the terminals you get triage from Linear, a dependency graph, diff review with an AI companion, and a PR dashboard. The workflow, not the panes.",
  },
  {
    q: "Which platforms?",
    a: "macOS today — one universal download for Apple silicon and Intel. santree is a native Tauri app and runs on Linux too, from source until packaged builds ship.",
  },
  {
    q: "Does it require Linear?",
    a: "No. Without Linear connected, the views show what's real: worktrees, terminals, and PRs all work. Connect a Linear org and triage lights up.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-2xl px-6">
        <SectionHeading kicker="FAQ" title="Questions" />
        <FadeUp className="mt-12">
          <div className="flex flex-col">
            {FAQS.map((item) => (
              <details key={item.q} className="faq-item group">
                <summary className="flex cursor-pointer items-center justify-between gap-4 py-5 text-left text-[15px] font-medium text-fg">
                  {item.q}
                  <span className="faq-icon shrink-0 text-muted-2" aria-hidden>
                    <svg
                      viewBox="0 0 12 12"
                      width={12}
                      height={12}
                      stroke="currentColor"
                      strokeWidth={1.4}
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M6 1v10M1 6h10" />
                    </svg>
                  </span>
                </summary>
                <p className="pb-5 pr-8 text-[14px] leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </FadeUp>
      </div>
    </section>
  );
}
