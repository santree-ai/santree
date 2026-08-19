import { DEMO_VIEWS, type DemoView } from "./data";

/** The demo's real controls: four pressed-state buttons. Hover selects too
 * (sweeping the row plays the tour, superset-style); any interaction stops
 * auto-advance. Mobile gets a horizontally scrollable strip. */
export function ViewSelector({
  view,
  cycling,
  onSelect,
}: {
  view: DemoView;
  /** Auto-advance is live — the active pill shows a progress underline. */
  cycling: boolean;
  onSelect: (view: DemoView) => void;
}) {
  return (
    // fieldset's UA-magic layout (min-inline-size:min-content, special legend
    // handling) breaks the overflow-x-auto strip and stretches the mobile page —
    // div+group is the reliable equivalent here.
    // biome-ignore lint/a11y/useSemanticElements: see the note above
    <div
      role="group"
      aria-label="Choose a santree view to preview"
      className="scrollbar-none -mx-6 flex gap-1.5 overflow-x-auto px-6 sm:mx-0 sm:justify-center sm:px-0"
    >
      {DEMO_VIEWS.map((v) => {
        const active = v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(v.id)}
            onMouseEnter={() => onSelect(v.id)}
            className={`relative shrink-0 overflow-hidden rounded-full border px-3.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors duration-200 ${
              active
                ? "border-accent/35 bg-accent/10 text-accent"
                : "border-hairline bg-white/2 text-muted hover:border-line-2 hover:text-fg"
            }`}
          >
            {v.label}
            <span className={`ml-1.5 tabular-nums ${active ? "text-accent/60" : "text-muted-4"}`}>
              {v.count}
            </span>
            {active && cycling && (
              <span
                key={v.id}
                className="demo-advance absolute inset-x-0 bottom-0 h-px bg-accent/70"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
