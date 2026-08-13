import { m, useScroll, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "~/lib/use-reduced-motion";
import { DEMO_VIEWS, type DemoView } from "./data";
import { DemoWindow } from "./demo-window";
import { TickerProvider, useTick } from "./ticker";
import { usePlaying } from "./use-playing";
import { ViewSelector } from "./view-selector";

/** The hero's interactive demo: selector + live window + scroll docking.
 * Auto-advance walks the pipeline (trees → reviews → triage → issues) on
 * the shared ticker — so it inherits pause-when-hidden for free — and stops
 * permanently on the first user interaction. */

const ADVANCE_MS = 7000;

function nextView(view: DemoView): DemoView {
  const i = DEMO_VIEWS.findIndex((v) => v.id === view);
  return (DEMO_VIEWS[(i + 1) % DEMO_VIEWS.length] ?? DEMO_VIEWS[0])?.id ?? "trees";
}

function AutoAdvance({ enabled, onAdvance }: { enabled: boolean; onAdvance: () => void }) {
  const tick = useTick(ADVANCE_MS, enabled);
  const last = useRef(0);
  useEffect(() => {
    if (tick > last.current) {
      last.current = tick;
      onAdvance();
    }
  }, [tick, onAdvance]);
  return null;
}

export function AppDemo({ autoAdvance = true }: { autoAdvance?: boolean }) {
  const [view, setView] = useState<DemoView>("trees");
  const [interacted, setInteracted] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playing = usePlaying(wrapRef);

  // Docking: the window starts a touch oversized and settles into the page
  // over the first ~280px of scroll. 1:1 scrub, no spring. The undocked pose
  // is baked into the prerendered HTML, so it's kept subtle enough to look
  // intentional without JS. Under reduced motion the ranges collapse to rest
  // post-hydration (the hook is false on the first render by construction).
  const reduced = usePrefersReducedMotion();
  const { scrollY } = useScroll();
  const scale = useTransform(scrollY, [0, 280], reduced ? [1, 1] : [1.04, 1]);
  const y = useTransform(scrollY, [0, 280], reduced ? [0, 0] : [24, 0]);

  const select = (v: DemoView) => {
    setInteracted(true);
    setView(v);
  };
  const cycling = autoAdvance && playing && !interacted;

  return (
    <div ref={wrapRef} className="flex flex-col gap-5">
      <TickerProvider playing={playing}>
        <AutoAdvance enabled={cycling} onAdvance={() => setView(nextView)} />
        <ViewSelector view={view} cycling={cycling} onSelect={select} />
        <m.div
          style={{ scale, y, transformOrigin: "50% 100%" }}
          onPointerEnter={() => setInteracted(true)}
        >
          <DemoWindow view={view} live />
        </m.div>
      </TickerProvider>
    </div>
  );
}
