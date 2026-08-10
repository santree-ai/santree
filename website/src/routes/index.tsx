import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "~/components/hero/hero";
import { FeatureRow } from "~/components/sections/feature-row";
import { FEATURES } from "~/components/sections/features";
import { Integrations } from "~/components/sections/integrations";
import { Loop } from "~/components/sections/loop";
import { OpenSource } from "~/components/sections/open-source";
import { ParallelStrip } from "~/components/sections/parallel-strip";
import { SectionHeading } from "~/components/ui/section-heading";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main id="main">
      <Hero />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <Loop />
      <section id="features" className="scroll-mt-28 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <SectionHeading
            kicker="The views"
            title="Four views. One pipeline."
            sub="Each view in santree is one stage of the loop, backed by real data — Linear, git, GitHub."
          />
          <div className="mt-24 flex flex-col gap-36">
            {FEATURES.map((f, i) => (
              <FeatureRow key={f.id} feature={f} flip={i % 2 === 1} />
            ))}
          </div>
        </div>
      </section>
      <ParallelStrip />
      <Integrations />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <OpenSource />
    </main>
  );
}
