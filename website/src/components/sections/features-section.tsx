import { FeatureRow } from "~/components/sections/feature-row";
import { FEATURES } from "~/components/sections/features";
import { SectionHeading } from "~/components/ui/section-heading";

/** The four view deep-dives, as one lazy chunk. */
export function FeaturesSection() {
  return (
    <section id="features" className="scroll-mt-28 py-16">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="The views"
          title="Four views, one pipeline"
          sub="Each view in santree is one stage of the loop, backed by real data: Linear, git, GitHub."
        />
        <div className="mt-24 flex flex-col gap-36">
          {FEATURES.map((f, i) => (
            <FeatureRow key={f.id} feature={f} flip={i % 2 === 1} />
          ))}
        </div>
      </div>
    </section>
  );
}
