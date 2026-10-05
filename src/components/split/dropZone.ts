/**
 * Where a dragged tab would land, from the pointer and a snapshot of the groups'
 * geometry taken when the drag began (nothing is measured per move).
 *
 * Three rules, each borrowed from a tool that got it right:
 *
 * - **A tab strip only ever reorders.** Hovering one inserts at the slot under
 *   the pointer; it never splits, so a drag that drifts up into a strip can't
 *   surprise anyone.
 * - **A group's outer band splits, its middle moves the tab in.** The band is a
 *   quarter of the group, never thinner than {@link EDGE_MIN} px and never more
 *   than a third (so the middle survives in a small group). Left/right win the
 *   corners.
 * - **The edge facing where the tab came from moves rather than splits.** Drag a
 *   tab into the neighbour on its right and the neighbour's left edge is the
 *   way *in*, not "split again, right where it came from".
 */
import type { Side } from "./layout";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GroupGeometry {
  id: string;
  /** The whole group, strip included. */
  outer: Box;
  /** The strip. */
  strip: Box;
  /** The content below the strip — where a split or move is aimed. */
  body: Box;
  /** The strip's drawn tabs, in order, with their index in the group's list
   *  (tabs in the overflow menu are not drawn, so the two can differ). */
  tabs: { index: number; box: Box }[];
  /** Index one past the group's last tab. */
  count: number;
}

export type DropTarget =
  | {
      kind: "strip";
      group: string;
      /** The slot to insert at, in the group's own list. */
      index: number;
      /** Where to draw the insertion bar, in viewport px. */
      x: number;
      box: Box;
    }
  | {
      kind: "pane";
      group: string;
      zone: Side | "center";
      /** The preview: the half the new group would take, or the whole body. */
      preview: Box;
    };

const EDGE_MIN = 80;
/** A group narrower (shorter) than twice these can't be split along that axis:
 *  either half would be too small to use. */
export const MIN_GROUP_W = 240;
export const MIN_GROUP_H = 140;
/** The preview's inset from the body, so it reads as a shape and not a tint. */
const INSET = 6;

const inside = (b: Box, x: number, y: number) =>
  x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;

const band = (size: number) => Math.min(Math.max(EDGE_MIN, size * 0.25), size / 3);

export function zoneAt(body: Box, x: number, y: number): Side | "center" {
  const bw = band(body.width);
  const bh = band(body.height);
  if (x < body.left + bw) return "left";
  if (x > body.left + body.width - bw) return "right";
  if (y < body.top + bh) return "top";
  if (y > body.top + body.height - bh) return "bottom";
  return "center";
}

/** Whether `side` of `target` is the edge it shares with `source`. */
function facesSource(target: Box, source: Box, side: Side): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 3;
  const overlapsY =
    Math.min(target.top + target.height, source.top + source.height) -
      Math.max(target.top, source.top) >
    0;
  const overlapsX =
    Math.min(target.left + target.width, source.left + source.width) -
      Math.max(target.left, source.left) >
    0;
  switch (side) {
    case "left":
      return overlapsY && near(source.left + source.width, target.left);
    case "right":
      return overlapsY && near(target.left + target.width, source.left);
    case "top":
      return overlapsX && near(source.top + source.height, target.top);
    case "bottom":
      return overlapsX && near(target.top + target.height, source.top);
  }
}

export function previewBox(body: Box, zone: Side | "center"): Box {
  const half = { ...body };
  if (zone === "left" || zone === "right") half.width = body.width / 2;
  if (zone === "top" || zone === "bottom") half.height = body.height / 2;
  if (zone === "right") half.left = body.left + body.width / 2;
  if (zone === "bottom") half.top = body.top + body.height / 2;
  return {
    left: half.left + INSET,
    top: half.top + INSET,
    width: Math.max(0, half.width - INSET * 2),
    height: Math.max(0, half.height - INSET * 2),
  };
}

/** The drop under the pointer, or `null` where a drop would change nothing (or
 *  there is nothing to drop on). `soleTab` says the dragged tab is alone in its
 *  group, which makes every drop on that group a no-op. */
export function resolveDrop(
  geometry: GroupGeometry[],
  source: string,
  soleTab: boolean,
  x: number,
  y: number,
): DropTarget | null {
  for (const g of geometry) {
    if (inside(g.strip, x, y)) {
      if (soleTab && g.id === source) return null;
      const last = g.tabs[g.tabs.length - 1];
      let index = last ? last.index + 1 : g.count;
      let bar = last ? last.box.left + last.box.width : g.strip.left;
      for (const t of g.tabs) {
        if (x < t.box.left + t.box.width / 2) {
          index = t.index;
          bar = t.box.left;
          break;
        }
      }
      return { kind: "strip", group: g.id, index, x: bar, box: g.strip };
    }
    if (inside(g.body, x, y)) {
      if (g.id === source && soleTab) return null;
      let zone = zoneAt(g.body, x, y);
      const from = geometry.find((s) => s.id === source);
      if (zone !== "center" && g.id !== source && from && facesSource(g.outer, from.outer, zone)) {
        zone = "center";
      }
      if ((zone === "left" || zone === "right") && g.body.width < MIN_GROUP_W * 2) zone = "center";
      if ((zone === "top" || zone === "bottom") && g.body.height < MIN_GROUP_H * 2) zone = "center";
      if (zone === "center" && g.id === source) return null;
      return { kind: "pane", group: g.id, zone, preview: previewBox(g.body, zone) };
    }
  }
  return null;
}
