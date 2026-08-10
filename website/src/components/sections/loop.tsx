import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";

const STEPS = [
  {
    n: "01",
    title: "Triage",
    body: "Pull tickets from Linear. Decide what an agent should take.",
    color: "#4493f8",
  },
  {
    n: "02",
    title: "Branch",
    body: "One click creates an isolated worktree. Your checkout stays clean.",
    color: "#a78bfa",
  },
  {
    n: "03",
    title: "Steer",
    body: "A Claude agent works in an embedded terminal. Watch it. Interrupt it. Redirect it.",
    color: "#2dd4a7",
  },
  {
    n: "04",
    title: "Review",
    body: "Read the diff with an AI companion that already read it too.",
    color: "#d29922",
  },
  {
    n: "05",
    title: "Ship",
    body: "Open the PR. The worktree merges back. Next ticket.",
    color: "#3fb950",
  },
];

export function Loop() {
  return (
    <section id="loop" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="How it works"
          title="One loop. Run it in parallel."
          sub="Ticket in, PR out — and nothing says you can only run it once at a time."
        />
        <div className="relative mt-16">
          {/* The wire the five stages hang on — a pulse of light runs the
              loop left to right. Visible only in the gaps between cards. */}
          <div className="pipeline-wire hidden lg:block" aria-hidden />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.05}>
                <SpotlightCard className="card h-full p-5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-white/[0.12]">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-4">{s.n}</span>
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: s.color, boxShadow: `0 0 10px ${s.color}80` }}
                      aria-hidden
                    />
                  </div>
                  <h3 className="mt-5 text-[15px] font-medium">{s.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{s.body}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
