/**
 * The main area as split groups: each group a {@link TabStrip} over the content
 * of its active tab, the groups tiled by a binary layout (see `layout.ts`).
 *
 * Every host's main area is one of these — Trees, Reviews and Triage — so a tab
 * of any kind can be dragged anywhere: onto a strip to reorder it or move it into
 * that group, onto a group's edge to split it, into a group's middle to move it
 * there. While dragging, the drop is drawn before it happens.
 *
 * **Content never remounts when a tab moves.** Every tab's content is rendered in
 * one flat list beside the groups (not inside them) and positioned over its
 * group's body, so moving a tab only changes a style. A tab's content can be a
 * running setup script, a scrolled diff or a terminal host, and none of them may
 * restart because the tab changed groups.
 *
 * The geometry is plain percentages of this container, derived from the layout
 * — nothing is measured to draw it. The 1px gaps between groups show the
 * container's own background, which is what draws the dividers.
 */
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { relayoutTerminals } from "../../features/terminal/relayout";
import { type StripTab, TabStrip } from "../TabStrip";
import { type Box, type DropTarget, type GroupGeometry, resolveDrop } from "./dropZone";
import {
  cornerGroup,
  groupOrder,
  nodeAt,
  placeLayout,
  type Rect,
  type SplitPath,
  setRatio,
  span,
} from "./layout";
import { SplitPaneContext } from "./SplitPaneContext";
import type { SplitController } from "./useSplitLayout";

/** The strip's height — `CHROME.subBar` (h-9). Content sits below it. */
const STRIP_H = 36;
/** How far a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD = 6;
/** The smallest a divider may squeeze a group to. */
const MIN_W = 160;
const MIN_H = 100;

export interface SplitWorkspaceProps<T extends string> {
  split: SplitController<T>;
  /** Every open tab as the strip draws it. Which group shows which is the
   *  layout's business; what a tab *is* stays the host's. */
  items: StripTab<T>[];
  /** A tab's content. `visible` is whether it is its group's active tab — a host
   *  that mounts a tab's content only while it shows returns `null` otherwise. */
  renderTab: (tab: T, visible: boolean) => ReactNode;
  ariaLabel: string;
  newTabMenu?: (close: () => void) => ReactNode;
  newTabMenuClassName?: string;
  newTabDisabled?: string;
  /** The host's whole-area controls, drawn at the end of the top-right group's
   *  strip — next to the right panel they mostly act on. */
  trailing?: ReactNode;
  /** Drawn in place of content when nothing at all is open. */
  empty?: ReactNode;
}

interface DragState<T> {
  tab: T;
  x: number;
  y: number;
  target: DropTarget | null;
}

const EDGE = 1e-6;

/** A rect of the container in CSS, nudged 1px off every edge it shares with a
 *  neighbour (that pixel is the divider), and `top` px further down. */
function boxStyle(r: Rect, top = 0): CSSProperties {
  const l = r.x > EDGE ? 1 : 0;
  const t = r.y > EDGE ? 1 : 0;
  return {
    left: `calc(${r.x * 100}% + ${l}px)`,
    top: `calc(${r.y * 100}% + ${t + top}px)`,
    width: `calc(${r.w * 100}% - ${l}px)`,
    height: `calc(${r.h * 100}% - ${t + top}px)`,
  };
}

const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

const ZONE_LABEL = {
  left: "Split left",
  right: "Split right",
  top: "Split up",
  bottom: "Split down",
  center: "Move here",
} as const;

export function SplitWorkspace<T extends string>({
  split,
  items,
  renderTab,
  ariaLabel,
  newTabMenu,
  newTabMenuClassName,
  newTabDisabled,
  trailing,
  empty,
}: SplitWorkspaceProps<T>) {
  const { layout } = split;
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState<T> | null>(null);
  // A divider being dragged: its ratio lives here until release, so a drag is a
  // re-render of this component and not a storage write per pointer move.
  const [live, setLive] = useState<{ path: SplitPath; ratio: number } | null>(null);

  const root = live ? setRatio(layout, live.path, live.ratio).root : layout.root;
  const placed = useMemo(() => placeLayout(root), [root]);
  const order = groupOrder(root);
  const isSplit = order.length > 1;
  const corner = cornerGroup(root);
  const byTab = useMemo(() => new Map(items.map((it) => [it.tab, it])), [items]);
  const groupOfTab = useMemo(() => {
    const m = new Map<T, string>();
    for (const id of order) for (const t of layout.groups[id]?.tabs ?? []) m.set(t, id);
    return m;
  }, [layout, order]);

  // Terminals are drawn by the terminal layer over their hosts; a host that
  // moved without resizing has to tell it so, in the same frame.
  const placement = `${JSON.stringify(root)}|${[...groupOfTab].join(",")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `placement` is the trigger, not an input.
  useLayoutEffect(() => relayoutTerminals(), [placement]);

  const latest = useRef({ layout, split });
  latest.current = { layout, split };

  /** The groups' geometry right now, for a drag that is starting. */
  const measure = (): GroupGeometry[] => {
    const container = containerRef.current;
    if (!container) return [];
    const { layout: l } = latest.current;
    return [...container.querySelectorAll<HTMLElement>(":scope > [data-split-group]")].flatMap(
      (el) => {
        const id = el.dataset.splitGroup as string;
        const strip = el.querySelector("[data-split-strip]");
        const body = el.querySelector("[data-split-body]");
        const group = l.groups[id];
        if (!strip || !body || !group) return [];
        const tabs = [...strip.querySelectorAll<HTMLElement>("[data-split-tab]")].map((t) => ({
          index: group.tabs.indexOf(t.dataset.splitTab as T),
          box: boxOf(t),
        }));
        return [
          {
            id,
            outer: boxOf(el),
            strip: boxOf(strip),
            body: boxOf(body),
            tabs,
            count: group.tabs.length,
          },
        ];
      },
    );
  };

  const startDrag = (tab: T, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const pointer = e.pointerId;
    const start = { x: e.clientX, y: e.clientY };
    let session: { geometry: GroupGeometry[]; source: string; sole: boolean } | null = null;
    let target: DropTarget | null = null;

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
      if (el.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
      if (!session) return;
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
      setDrag(null);
      // The press ends on the tab it started on, which would read as a click
      // selecting it — swallow that one click.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (!commit || !target) return;
      const s = latest.current.split;
      if (target.kind === "strip") s.move(tab, target.group, target.index);
      else if (target.zone === "center") s.move(tab, target.group);
      else s.split(tab, target.group, target.zone);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      if (!session) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        const { layout: l } = latest.current;
        const source = Object.keys(l.groups).find((id) => l.groups[id].tabs.includes(tab));
        if (!source) return finish(false);
        // Captured, so the drag keeps its events over a terminal (which would
        // otherwise take them for its own mouse reporting).
        el.setPointerCapture(pointer);
        session = { geometry: measure(), source, sole: l.groups[source].tabs.length === 1 };
        // No text selection trailing the drag across the panes it crosses.
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      target = resolveDrop(session.geometry, session.source, session.sole, ev.clientX, ev.clientY);
      setDrag({ tab, x: ev.clientX, y: ev.clientY, target });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) finish(true);
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) finish(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !session) return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
  };

  const startResize = (path: SplitPath, e: ReactPointerEvent<HTMLElement>) => {
    const container = containerRef.current;
    const node = nodeAt(layout.root, path);
    const at = placed.splits.find((s) => s.path === path);
    if (e.button !== 0 || !container || node?.kind !== "split" || !at) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const c = container.getBoundingClientRect();
    const row = node.dir === "row";
    const origin = row ? c.left + at.rect.x * c.width : c.top + at.rect.y * c.height;
    const size = row ? at.rect.w * c.width : at.rect.h * c.height;
    const min = row ? MIN_W : MIN_H;
    const lo = Math.min(0.5, (span(node.a, node.dir) * min) / size);
    const hi = Math.max(0.5, 1 - (span(node.b, node.dir) * min) / size);
    let ratio = node.ratio;
    const onMove = (ev: PointerEvent) => {
      const p = row ? ev.clientX : ev.clientY;
      ratio = Math.min(hi, Math.max(lo, (p - origin) / size));
      setLive({ path, ratio });
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      latest.current.split.resize(path, ratio);
      setLive(null);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const nothingOpen = order.every((id) => (layout.groups[id]?.tabs.length ?? 0) === 0);
  const contentOrder = useMemo(
    // Sorted by id, not by group: a moved tab keeps its place among its
    // siblings, so React never re-inserts its DOM (which would lose its scroll).
    () => [...groupOfTab.keys()].sort(),
    [groupOfTab],
  );

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 bg-line">
      {order.map((id) => {
        const g = layout.groups[id];
        const rect = placed.groups.get(id);
        if (!g || !rect) return null;
        const focused = layout.focused === id;
        return (
          <div
            key={id}
            data-split-group={id}
            className="absolute flex flex-col bg-app"
            style={boxStyle(rect)}
            onPointerDownCapture={() => split.focus(id)}
          >
            <TabStrip
              tabs={g.tabs.flatMap((t) => byTab.get(t) ?? [])}
              active={g.active}
              onSelect={split.select}
              ariaLabel={isSplit ? `${ariaLabel} (group ${order.indexOf(id) + 1})` : ariaLabel}
              newTabMenu={newTabMenu}
              newTabMenuClassName={newTabMenuClassName}
              newTabDisabled={newTabDisabled}
              trailing={id === corner ? trailing : undefined}
              muted={isSplit && !focused}
              shortcut={focused}
              dragging={drag?.tab ?? null}
              onTabPointerDown={startDrag}
            />
            <div data-split-body className="min-h-0 flex-1" />
          </div>
        );
      })}

      {contentOrder.map((tab) => {
        const id = groupOfTab.get(tab) as string;
        const rect = placed.groups.get(id);
        const g = layout.groups[id];
        if (!rect || !g) return null;
        const visible = g.active === tab;
        return (
          <SplitPaneContext.Provider
            key={tab}
            value={{
              visible,
              focused: visible && layout.focused === id,
              activate: () => latest.current.split.focus(id),
            }}
          >
            <div
              className={visible ? "absolute flex flex-col overflow-hidden" : "hidden"}
              style={boxStyle(rect, STRIP_H)}
              onPointerDownCapture={() => split.focus(id)}
            >
              {renderTab(tab, visible)}
            </div>
          </SplitPaneContext.Provider>
        );
      })}

      {nothingOpen && empty && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col" style={{ top: STRIP_H }}>
          {empty}
        </div>
      )}

      {placed.splits.map((s) => {
        const row = s.dir === "row";
        const pos = row ? s.rect.x + s.rect.w * s.ratio : s.rect.y + s.rect.h * s.ratio;
        const dragging = live?.path === s.path;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a focusable, resizable separator is the ARIA window-splitter pattern; <hr> can't take focus or pointer drags.
          <div
            key={s.path}
            role="separator"
            aria-orientation={row ? "vertical" : "horizontal"}
            aria-label="Resize split"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.ratio * 100)}
            tabIndex={0}
            title="Drag to resize — double-click to even out"
            onPointerDown={(e) => startResize(s.path, e)}
            onDoubleClick={() => split.equalize(s.path)}
            onKeyDown={(e) => {
              const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
              if (step === undefined) return;
              e.preventDefault();
              split.resize(s.path, Math.min(0.9, Math.max(0.1, s.ratio + step * 0.02)));
            }}
            // Above the terminal layer (z-30): the grab area overlaps the panes
            // on both sides of the 1px gap, and a terminal drawn there would
            // otherwise take the press.
            className={`group absolute z-[35] outline-none ${
              row ? "cursor-col-resize" : "cursor-row-resize"
            }`}
            style={
              row
                ? {
                    left: `calc(${pos * 100}% - 3px)`,
                    top: `${s.rect.y * 100}%`,
                    width: 7,
                    height: `${s.rect.h * 100}%`,
                  }
                : {
                    top: `calc(${pos * 100}% - 3px)`,
                    left: `${s.rect.x * 100}%`,
                    height: 7,
                    width: `${s.rect.w * 100}%`,
                  }
            }
          >
            <span
              className={`pointer-events-none absolute bg-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${
                dragging ? "opacity-100" : ""
              } ${row ? "inset-y-0 left-[2px] w-[3px]" : "inset-x-0 top-[2px] h-[3px]"}`}
            />
          </div>
        );
      })}

      {drag && <DragOverlay drag={drag} item={byTab.get(drag.tab)} />}
    </div>
  );
}

/** The drag's picture: the tab under the pointer, and where it would land —
 *  the half a split would take, the group it would move into, or the slot in a
 *  strip. Portalled to the body and fixed, above the terminal layer, so it
 *  draws over a terminal pane like over anything else. */
function DragOverlay<T extends string>({
  drag,
  item,
}: {
  drag: DragState<T>;
  item: StripTab<T> | undefined;
}) {
  const { target } = drag;
  // Mount the preview where it first appears, then let it glide between zones.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return createPortal(
    <>
      {target?.kind === "pane" && (
        <div
          className={`pointer-events-none fixed z-[60] flex items-center justify-center rounded-md border-2 border-accent ${
            shown ? "transition-all duration-150 ease-out" : ""
          }`}
          style={{
            left: target.preview.left,
            top: target.preview.top,
            width: target.preview.width,
            height: target.preview.height,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
          }}
        >
          <span className="rounded bg-raised px-2 py-1 text-[11px] font-medium text-fg-2 shadow-sm">
            {ZONE_LABEL[target.zone]}
          </span>
        </div>
      )}
      {target?.kind === "strip" && (
        <div
          className="pointer-events-none fixed z-[60] w-[2px] bg-accent"
          style={{ left: target.x - 1, top: target.box.top + 6, height: target.box.height - 12 }}
        />
      )}
      <div
        className="pointer-events-none fixed z-[70] flex max-w-[200px] items-center gap-1.5 rounded border border-line-2 bg-raised px-2.5 py-1 text-[11.5px] font-medium text-fg-2 shadow-md"
        style={{ left: drag.x + 12, top: drag.y + 10 }}
      >
        {item?.icon}
        <span className="truncate">{item?.label ?? ""}</span>
      </div>
    </>,
    document.body,
  );
}
