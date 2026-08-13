import { m } from "framer-motion";
import { useRef } from "react";
import { WindowTopBar } from "./chrome";
import { DEMO_VIEWS, type DemoView } from "./data";
import { DESIGN_H, DESIGN_W, useFitScale } from "./use-fit-scale";
import { IssuesView } from "./views/issues-view";
import { ReviewsView } from "./views/reviews-view";
import { TreesView } from "./views/trees-view";
import { TriageView } from "./views/triage-view";

/** The fake app window. Authored at DESIGN_W×DESIGN_H and scaled as one
 * unit (see use-fit-scale.ts + .demo-fit in styles.css). The window is a
 * picture — role="img", inner content pointer-events:none — the external
 * selector is the interface.
 *
 * `live` mounts all four views crossfading on opacity (nothing unmounts, so
 * every view's text is in the prerendered HTML); `live=false` renders one
 * frozen view — the cheap variant for feature rows. */

const VIEW_COMPONENTS: Record<DemoView, React.ComponentType<{ live: boolean }>> = {
  triage: TriageView,
  issues: IssuesView,
  trees: TreesView,
  reviews: ReviewsView,
};

export function DemoWindow({ view, live = false }: { view: DemoView; live?: boolean }) {
  const fitRef = useRef<HTMLDivElement>(null);
  useFitScale(fitRef);
  const meta = DEMO_VIEWS.find((v) => v.id === view);
  const Single = VIEW_COMPONENTS[view];

  return (
    <div
      ref={fitRef}
      role="img"
      aria-label={meta?.aria}
      className="demo-fit relative aspect-16/10 w-full overflow-hidden rounded-xl border border-hairline shadow-[0_1px_1px_rgba(0,0,0,0.45),0_24px_60px_-16px_rgba(0,0,0,0.65),0_48px_120px_-24px_rgba(0,0,0,0.8),0_0_120px_-40px_rgba(45,212,167,0.3)]"
    >
      <div
        className="demo-canvas pointer-events-none absolute left-1/2 top-1/2 flex select-none flex-col bg-panel text-left"
        style={{ width: DESIGN_W, height: DESIGN_H }}
      >
        <WindowTopBar view={view} />
        <div className="relative min-h-0 flex-1">
          {live ? (
            DEMO_VIEWS.map((v) => {
              const View = VIEW_COMPONENTS[v.id];
              const active = v.id === view;
              return (
                <m.div
                  key={v.id}
                  className="absolute inset-0 flex flex-col"
                  initial={false}
                  animate={{ opacity: active ? 1 : 0 }}
                  transition={{ duration: 0.25, ease: "easeOut" }}
                >
                  <View live={active} />
                </m.div>
              );
            })
          ) : (
            <div className="absolute inset-0 flex flex-col">
              <Single live={false} />
            </div>
          )}
        </div>
      </div>
      {/* Edge lighting: brighter hairline along the top, unscaled so it stays
          1px crisp at every fit scale. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
        aria-hidden
      />
      {/* Bottom dissolve into the page. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[9%] bg-linear-to-b from-transparent to-app/70"
        aria-hidden
      />
    </div>
  );
}
