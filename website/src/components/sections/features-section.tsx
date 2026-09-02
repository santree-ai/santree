import { FeatureRow } from "~/components/sections/feature-row";
import { FEATURES } from "~/components/sections/features";
import { SectionHeading } from "~/components/ui/section-heading";

/** The view deep-dives, as one lazy chunk. */
export function FeaturesSection() {
  return (
    <section id="features" className="scroll-mt-28 py-16">
      {/* Wider than the page's other sections on purpose: these rows exist
          to show the app, and at max-w-6xl the window was too small to read. */}
      <div className="mx-auto max-w-7xl px-6">
        <SectionHeading
          kicker="The views"
          title="One window, one loop"
          sub="Each surface is one stage of the loop, backed by real data: Linear, git, GitHub. Captured from the app, not mocked up."
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
