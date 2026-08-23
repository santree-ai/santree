import { m, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { DemoWindow } from "~/components/app-demo";
import { FadeUp } from "~/components/motion/fade-up";
import type { Feature } from "~/components/sections/features";
import { usePrefersReducedMotion } from "~/lib/use-reduced-motion";

/** One alternating feature row: copy on one side, a frozen frame of the
 * real demo window on the other, drifting a touch slower than the scroll. */
export function FeatureRow({ feature, flip }: { feature: Feature; flip: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], reduced ? [0, 0] : [20, -20]);

  return (
    <div
      id={feature.id}
      ref={ref}
      // The column template has to flip WITH the order — `flip` alone only
      // reorders, which parked the window in the 2fr column and shrank it
      // on every other row.
      className={`grid scroll-mt-28 items-center gap-12 lg:gap-16 ${
        flip ? "lg:grid-cols-[7fr_4fr]" : "lg:grid-cols-[4fr_7fr]"
      }`}
    >
      <FadeUp className={flip ? "lg:order-2" : ""}>
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
      </FadeUp>
      <FadeUp delay={0.08} className={flip ? "lg:order-1" : ""}>
        <m.div style={{ y }}>
          <DemoWindow view={feature.id} />
        </m.div>
      </FadeUp>
    </div>
  );
}
