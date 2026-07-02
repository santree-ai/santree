/**
 * A "blocked by" / "blocks" row in the inspector. Every referenced ticket lives
 * in the graph (the backend pulls in blockers owned by others or already done as
 * grayed context nodes), so clicking the row focuses it and pans the canvas to it,
 * revealing the grayed layer if the "Actionable only" filter is hiding it.
 *
 * Hovering shows a richer preview card — full title, state, and the assignee — so
 * you can see what (and whose) it is without navigating. There's no "open in
 * graph" button: clicking the row itself does that.
 */
import { memo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Avatar } from "../../components/Avatar";
import { Pill } from "../../components/primitives";

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
  /** Assignee display name, or null when unassigned. */
  assignee?: string | null;
  /** Assignee avatar URL, when present. */
  assigneeAvatar?: string | null;
  onOpenInGraph: (id: string) => void;
}

export const BlockerRow = memo(function BlockerRow({
  id,
  title,
  color,
  state,
  grayed,
  foreignProject,
  assignee,
  assigneeAvatar,
  onOpenInGraph,
}: BlockerRowProps) {
  const [open, setOpen] = useState(false);
  // The card is portaled to <body> (so no panel `overflow` can clip it when it
  // opens left, out over the graph), which means we position it with fixed
  // viewport coords taken from the row, refreshed each time it opens.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const openCard = () => {
    window.clearTimeout(closeTimer.current);
    const r = btnRef.current?.getBoundingClientRect();
    // Anchor the card's right edge just left of the row, top-aligned, so it floats
    // out over the content area instead of hanging off the right-edge panel.
    if (r) setCoords({ top: r.top, right: window.innerWidth - r.left + 8 });
    setOpen(true);
  };
  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    // The button is the control; the wrapper only tracks hover so the card stays
    // open while the pointer travels from the row onto it.
    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only affordance over an interactive child
    <div className="relative" onMouseEnter={openCard} onMouseLeave={scheduleClose}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => onOpenInGraph(id)}
        onFocus={openCard}
        onBlur={scheduleClose}
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
        {assignee && <Avatar name={assignee} src={assigneeAvatar} size={16} />}
        {foreignProject && (
          <span className="flex-none truncate rounded border border-cross/40 bg-cross/[0.08] px-[5px] py-px font-mono text-[8.5px] text-cross">
            ↗ {foreignProject}
          </span>
        )}
      </button>

      {open &&
        coords &&
        createPortal(
          // Open to the *left* of the row, not below: this lives in the right-edge
          // inspector panel, so the card floats out over the content area (mirroring
          // how Linear opens it beside the item, away from the panel edge). Portaled
          // to <body> so the panel's scroll/overflow can't clip it; it carries its
          // own hover handlers since it's no longer a descendant of the row wrapper.
          // biome-ignore lint/a11y/noStaticElementInteractions: hover-only affordance bridging the row
          <div
            onMouseEnter={openCard}
            onMouseLeave={scheduleClose}
            style={{ position: "fixed", top: coords.top, right: coords.right }}
            className="z-[100] w-72 rounded-xl border border-line-2 bg-popover p-3 shadow-xl"
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10.5px] text-muted-2">{id}</span>
              <Pill color={color} className="px-1.5 py-px text-[10px] font-medium">
                {state}
              </Pill>
              {grayed && <span className="text-[10px] text-muted-4">not yours</span>}
            </div>

            <div className="text-[12.5px] leading-[1.35] font-medium text-fg-bright">
              {title || id}
            </div>

            <div className="mt-3 flex items-center gap-2 border-t border-hairline pt-2.5">
              {assignee ? (
                <>
                  <Avatar name={assignee} src={assigneeAvatar} size={18} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-2">
                    {assignee}
                  </span>
                </>
              ) : (
                <span className="flex-1 text-[11px] text-muted-4 italic">Unassigned</span>
              )}
              {foreignProject && (
                <span className="flex-none truncate rounded border border-cross/40 bg-cross/[0.08] px-[5px] py-px font-mono text-[9px] text-cross">
                  ↗ {foreignProject}
                </span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
