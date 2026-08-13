import { FadeUpGroup, FadeUpItem } from "~/components/motion/fade-up";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";

/** The local-first / security story. No cloud, no credential handling,
 * MIT in the open — the three reasons to trust a tool that runs agents
 * against your repo. */

const CARDS = [
  {
    title: "Local-first",
    body: "A desktop app, not a cloud IDE. Worktrees, terminals, and diffs live on your disk — santree itself sends nothing anywhere.",
    icon: (
      <svg
        viewBox="0 0 20 20"
        width={22}
        height={22}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        aria-hidden
      >
        <path d="M3 8.5 10 3l7 5.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 8v8h10V8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8.5 16v-4h3v4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: "Your keys stay yours",
    body: "The terminal runs the real, unmodified Claude CLI — you log in yourself, and santree never reads, stores, or proxies an agent's credentials.",
    icon: (
      <svg
        viewBox="0 0 20 20"
        width={22}
        height={22}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        aria-hidden
      >
        <circle cx="7" cy="8" r="3.5" />
        <path d="M10 10.5 16.5 17M14 14.5l2-2M16 16.5l2-2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "MIT, in the open",
    body: "Read the code that runs your agents. The compliance constraints are documented in the repo and enforced in the architecture, not a promise.",
    icon: (
      <svg
        viewBox="0 0 20 20"
        width={22}
        height={22}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        aria-hidden
      >
        <path d="m7 6-4 4 4 4M13 6l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function Trust() {
  return (
    <section id="trust" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeading
          kicker="Local-first"
          title="Your repo never leaves your machine."
          sub="Running agents against your code is a trust decision. santree keeps it a small one."
        />
        <FadeUpGroup className="mt-14 grid gap-3 sm:grid-cols-3">
          {CARDS.map((card) => (
            <FadeUpItem key={card.title} className="h-full">
              <SpotlightCard className="card h-full px-6 py-8">
                <span className="text-accent/80">{card.icon}</span>
                <h3 className="mt-4 text-[15px] font-medium">{card.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{card.body}</p>
              </SpotlightCard>
            </FadeUpItem>
          ))}
        </FadeUpGroup>
      </div>
    </section>
  );
}
