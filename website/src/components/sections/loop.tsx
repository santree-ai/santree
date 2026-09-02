import { type MotionValue, m, useMotionValueEvent, useScroll, useTransform } from "framer-motion";
import { useRef, useState } from "react";
import { FadeUpGroup, FadeUpItem } from "~/components/motion/fade-up";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";
import { usePrefersReducedMotion } from "~/lib/use-reduced-motion";

const STEPS = [
  {
    n: "01",
    title: "Triage",
    body: "The queue sits in the sidebar with its SLA clock. Open a ticket, hand it to an agent.",
    color: "#4493f8",
  },
  {
    n: "02",
    title: "Branch",
    body: "Run creates an isolated worktree per ticket. Your checkout stays clean.",
    color: "#a78bfa",
  },
  {
    n: "03",
    title: "Steer",
    body: "Codex or Claude Code works in a real terminal. Watch it, interrupt it, redirect it. The sidebar tells you when it needs you.",
    color: "#2dd4a7",
  },
  {
    n: "04",
    title: "Review",
    body: "An AI review drafts the comments; the work queue turns checks and reviews into the next task.",
    color: "#d29922",
  },
  {
    n: "05",
    title: "Ship",
    body: "Open the PR from the worktree. Merge it. Delete the tree. Next ticket.",
    color: "#3fb950",
  },
];

function LoopCard({
  step,
  index,
  lit,
  progress,
  reduced,
}: {
  step: (typeof STEPS)[number];
  index: number;
  lit: boolean;
  progress: MotionValue<number>;
  reduced: boolean;
}) {
  // Each card carries its own top rule that fills in the step's color as
  // scroll hands the loop from stage to stage — no line crossing the gaps.
  const fill = useTransform(
    progress,
    [index / STEPS.length, (index + 1) / STEPS.length],
    reduced ? [1, 1] : [0, 1],
  );

  return (
    <SpotlightCard className="card h-full overflow-hidden p-5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-white/[0.12]">
      <m.span
        className="absolute inset-x-5 top-0 h-px origin-left"
        style={{ scaleX: fill, background: step.color, opacity: 0.75 }}
        aria-hidden
      />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-4">{step.n}</span>
        <span
          className="size-1.5 rounded-full transition-[opacity,box-shadow] duration-500"
          style={{
            background: step.color,
            opacity: lit ? 1 : 0.4,
            boxShadow: lit ? `0 0 10px ${step.color}80` : "none",
          }}
          aria-hidden
        />
      </div>
      <h3 className="mt-5 text-[15px] font-medium">{step.title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{step.body}</p>
    </SpotlightCard>
  );
}

export function Loop() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 0.85", "end 0.55"] });
  const [lit, setLit] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => {
    setLit(reduced ? STEPS.length : Math.min(STEPS.length, Math.max(0, Math.ceil(v * 5.2))));
  });

  return (
    <section id="loop" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="How it works"
          title="One loop, run in parallel."
          sub="Ticket in, PR out. And nothing says you can only run it once at a time."
        />
        <div ref={ref} className="relative mt-16">
          <FadeUpGroup className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <FadeUpItem key={s.n} className="h-full">
                <LoopCard
                  step={s}
                  index={i}
                  lit={i < lit}
                  progress={scrollYProgress}
                  reduced={reduced}
                />
              </FadeUpItem>
            ))}
          </FadeUpGroup>
        </div>
      </div>
    </section>
  );
}
