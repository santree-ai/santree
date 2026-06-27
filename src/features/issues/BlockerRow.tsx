/**
 * A "blocked by" / "blocks" row in the inspector. Every referenced ticket lives
 * in the graph (the backend pulls in blockers owned by others or already done as
 * grayed context nodes), so the action is always "open in graph": clicking the
 * row focuses it and pans the canvas to it, revealing the grayed layer if the
 * "Actionable only" filter is hiding it. Hovering shows the full title + state
 * so you can read what it is without navigating.
 */
import { useRef, useState } from "react";

import { CrosshairIcon } from "../../components/icons";

export interface BlockerRowProps {
  id: string;
  title: string;
  /** Status dot / pill color. */
  color: string;
  /** Human status label (e.g. "Done"). */
  state: string;
  /** Non-actionable context ticket (owned by others, or done) — muted. */
  grayed: boolean;
  /** Set when this blocker lives in another project band. */
  foreignProject?: string | null;
  onOpenInGraph: (id: string) => void;
}

export function BlockerRow({
  id,
  title,
  color,
  state,
  grayed,
  foreignProject,
  onOpenInGraph,
}: BlockerRowProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const openCard = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    // The button is the control; the wrapper only tracks hover so the card stays
    // open while the pointer travels from the row down onto it.
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only affordance over an interactive child
    <div className="relative" onMouseEnter={openCard} onMouseLeave={scheduleClose}>
      <button
        type="button"
        onClick={() => onOpenInGraph(id)}
        className="flex w-full items-center gap-2 rounded-lg border border-line-2 bg-input px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-hover"
        style={grayed ? { borderStyle: "dashed" } : undefined}
      >
        <span className="h-2 w-2 flex-none rounded-full" style={{ background: color }} />
        <span className="flex-none font-mono text-[10.5px] text-muted-2">{id}</span>
        <span
          className={`min-w-0 flex-1 truncate text-[11.5px] ${grayed ? "text-muted-3" : "text-fg-3"}`}
        >
          {title || id}
        </span>
        {foreignProject && (
          <span className="flex-none truncate rounded border border-cross/40 bg-cross/[0.08] px-[5px] py-px font-mono text-[8.5px] text-cross">
            ↗ {foreignProject}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 rounded-xl border border-line-2 bg-popover p-3 shadow-xl">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-mono text-[10.5px] text-muted-2">{id}</span>
            <span
              className="rounded px-1.5 py-px text-[10px] font-medium"
              style={{
                color,
                background: `color-mix(in srgb, ${color} 14%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
              }}
            >
              {state}
            </span>
            {grayed && <span className="text-[10px] text-muted-4">not yours</span>}
          </div>

          <div className="mb-3 text-[12.5px] leading-[1.35] font-medium text-fg-bright">
            {title || id}
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenInGraph(id);
            }}
            className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line-2 bg-input py-1.5 text-[11px] text-muted-2 hover:text-fg-2"
          >
            <CrosshairIcon size={12} className="text-[color:var(--accent)]" />
            Open in graph
          </button>
        </div>
      )}
    </div>
  );
}
