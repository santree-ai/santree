import { Reveal } from "~/components/reveal";
import type { Feature } from "~/components/sections/features";
import { ScreenshotFrame } from "~/components/ui/screenshot-frame";

/** One alternating feature row: copy on one side, the view's screenshot slot
 * on the other. Still — the frame doesn't chase the pointer. */
export function FeatureRow({ feature, flip }: { feature: Feature; flip: boolean }) {
  return (
    <div
      id={feature.id}
      className="grid scroll-mt-28 items-center gap-12 lg:grid-cols-[2fr_3fr] lg:gap-20"
    >
      <Reveal className={flip ? "lg:order-2" : ""}>
        <p
          className="font-mono text-[11px] uppercase tracking-[0.18em]"
          style={{ color: feature.color }}
        >
          {feature.kicker}
        </p>
        <h3 className="mt-4 text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.02em]">
          {feature.title}
        </h3>
        <p className="mt-4 text-pretty text-[15px] leading-relaxed text-muted">{feature.body}</p>
        {feature.extra ? (
          <p className="mt-3 text-pretty text-[13px] leading-relaxed text-muted-2">
            {feature.extra}
          </p>
        ) : null}
      </Reveal>
      <Reveal delay={0.08} className={flip ? "lg:order-1" : ""}>
        <ScreenshotFrame view={feature.kicker} />
      </Reveal>
    </div>
  );
}
