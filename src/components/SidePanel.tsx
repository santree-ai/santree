/** The shell every right-hand panel is built on: an icon strip of panes over
 *  the selected one, resizable by its left edge and collapsible to nothing.
 *
 *  Four hosts sit on it — the worktree's panel in Trees ({@link FilePickerPanel}),
 *  the pull request's rail in Reviews ({@link ReviewSidePanel}), the triage
 *  ticket's ({@link TriageSidePanel}) and the Tickets page's one-pane rail
 *  ({@link RightPanel}) — and they mean the same thing by it: *reference beside
 *  the work*, which is what separates a pane here from a tab in the main area.
 *  Those are places you type; this is what you consult while typing. Which panes
 *  exist, what their dots mean and what the body renders belong to the host; the
 *  chrome, the keyboard model and the geometry live here, so they can't drift
 *  into panels that feel different for no reason.
 *
 *  It owns no state. The selected pane, the collapsed flag and the width are all
 *  things the host persists and binds ⌘L to, so they come in as props — and
 *  `cssVar` with them, because two panels sharing one custom property would
 *  resize each other. */
import { type CSSProperties, type ReactNode, useRef } from "react";

import { useEdgeResize } from "../lib/useEdgeResize";
import { PanelIcon } from "./icons";
import { EdgeResizeHandle, onTabStripKeyDown } from "./primitives";

/** One pane on offer. `dot` is a colour when the tab has something to say and
 *  null the rest of the time, which is most tabs most of the time — see the
 *  strip's comment below for what a dot is allowed to mean. */
export interface SidePanelTab<T extends string> {
  tab: T;
  label: string;
  icon: ReactNode;
  dot?: string | null;
  /** A moment's count on the tab — the queue's "+2" as it fills. It takes the
   *  dot's corner, so it stands in for the dot while it shows. */
  badge?: ReactNode;
}

/** How far past its minimum a drag has to go before the panel collapses instead
 *  of clamping: a quarter narrower than the panel is ever allowed to be. Far
 *  enough that clamping at the minimum still feels like a wall, close enough that
 *  "shove it out of the way" is one gesture. Derived rather than passed so the
 *  two panels can't end up with different-feeling shoves. */
function collapseAt(min: number): number {
  return Math.round(min * 0.75);
}

/**
 * The panel's show/hide control.
 *
 * One component with one geometry, because it changes *host*: the panel's own
 * header owns it while the panel is open, and (in Trees) the main tab bar's
 * trailing edge takes it over once the panel is gone. Both hosts end their
 * content 8px from the same right edge, so the button stays put across the toggle
 * instead of stepping sideways — a control that moves when you press it reads as
 * two different controls.
 */
export function PanelToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Show panel" : "Hide panel"}
      title={collapsed ? "Show panel (⌘L)" : "Hide panel (⌘L)"}
      className="flex h-[22px] w-7 flex-none cursor-pointer items-center justify-center self-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <PanelIcon size={14} />
    </button>
  );
}

export function SidePanel<T extends string>({
  tabs,
  active,
  onSelect,
  collapsed,
  onToggle,
  width: storedWidth,
  onWidth,
  cssVar,
  min,
  max,
  resetTo,
  ariaLabel,
  children,
}: {
  tabs: SidePanelTab<T>[];
  active: T;
  onSelect: (tab: T) => void;
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  onWidth: (w: number) => void;
  /** The custom property the live drag writes. Must be unique per host. */
  cssVar: string;
  min: number;
  max: number;
  /** The width a collapse-by-drag restores to, and the style fallback. */
  resetTo: number;
  /** The tablist's accessible name. */
  ariaLabel: string;
  /** The active pane — the host picks it, this only frames it. */
  children: ReactNode;
}): ReactNode {
  const resizeTarget = useRef<HTMLDivElement>(null);

  // A width persisted before the strip grew a pane sits below the new minimum,
  // and nothing re-clamps a stored number — the drag clamps, but only once the
  // user drags. Clamp on the way out so the strip can't open overflowing, and
  // leave what's stored alone in case the minimum ever comes back down.
  const width = Math.min(max, Math.max(min, storedWidth));

  const resize = useEdgeResize({
    cssVar,
    target: resizeTarget,
    width,
    min,
    max,
    edge: "left",
    onCommit: onWidth,
    collapse: { at: collapseAt(min), resetTo, onCollapse: onToggle },
  });

  // Fully hidden when collapsed — nothing is left behind to bring it back, so
  // each host puts that control somewhere its own layout keeps visible (Trees on
  // the main tab bar's trailing edge, where the panel's own toggle was).
  if (collapsed) return null;

  return (
    <div
      ref={resizeTarget}
      className="relative flex flex-none flex-col border-l border-line bg-deep"
      style={
        {
          [cssVar]: `${width}px`,
          width: `var(${cssVar}, ${resetTo}px)`,
        } as CSSProperties
      }
    >
      <EdgeResizeHandle edge="left" {...resize} />
      {/* Icons only: the strip has to fit a narrow panel and the panes are
          recognisable by glyph (the Linear mark, the GitHub mark, a generic AI
          spark, a checklist, files, branch, clock); the name rides in the tooltip
          and the accessible label. The selected pane is marked by an underline at the strip's edge,
          not a filled tile, so the strip reads as tabs rather than as a row of
          buttons; the panel's own collapse control sits at the far end, where it
          can't be mistaken for another pane.

          A tab's dot means "there is something here": pending changes and open
          queue items take the accent, because they are counts. A *status* carries
          its own colour instead — the PR's is the CI rollup, and the AI work
          queue's is amber when its brief was written against a head the PR has
          since moved past (advice about code that has changed reads as current,
          which is worse than none). See {@link aiWorkDot} for why that beats the
          count. */}
      <div
        data-tauri-drag-region
        className="flex h-9 flex-none items-stretch justify-between border-b border-line px-2"
      >
        <div
          role="tablist"
          aria-label={ariaLabel}
          onKeyDown={onTabStripKeyDown}
          className="flex items-stretch gap-1"
        >
          {tabs.map(({ tab, label, icon, dot, badge }) => {
            const on = active === tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={on}
                aria-label={label}
                title={label}
                tabIndex={on ? 0 : -1}
                onClick={() => onSelect(tab)}
                className={`relative flex w-8 cursor-pointer items-center justify-center transition-colors ${
                  on ? "text-fg" : "text-muted-4 hover:text-fg-2"
                }`}
              >
                {icon}
                {badge ? (
                  <span
                    aria-hidden
                    className="absolute top-1 -right-0.5 rounded-full bg-fg px-1 font-mono text-[9px] leading-[13px] text-app tabular-nums"
                  >
                    {badge}
                  </span>
                ) : (
                  dot && (
                    <span
                      aria-hidden
                      className="absolute top-2 right-1 h-1.5 w-1.5 rounded-full"
                      style={{ background: dot }}
                    />
                  )
                )}
                {on && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-fg"
                  />
                )}
              </button>
            );
          })}
        </div>
        <PanelToggle collapsed={collapsed} onToggle={onToggle} />
      </div>

      {children}
    </div>
  );
}
