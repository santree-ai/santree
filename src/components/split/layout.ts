/**
 * The split layout of a main area: a binary tree of **tab groups**, each with its
 * own tab strip — the VS Code shape, not "a tab that contains panes".
 *
 * Pure data and pure functions, so every rule about where a tab goes is testable
 * without a DOM. A layout never decides *which* tabs exist: the host says what is
 * open, and {@link normalize} fits the stored layout to that — dropping what has
 * closed, placing what is new in the focused group, collapsing a group once its
 * last tab has left. Everything the user does (pick a tab, drag it, resize a
 * divider) is one of the operations below, applied to the stored layout.
 */

/** `row` puts the two halves side by side (a vertical divider); `column` stacks
 *  them (a horizontal one). */
export type SplitDir = "row" | "column";

export type LayoutNode =
  | { kind: "group"; id: string }
  | { kind: "split"; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export interface TabGroup<T extends string> {
  /** In strip order. */
  tabs: T[];
  active: T | null;
  /** This group's tabs by most recent activation, newest first: where the
   *  selection goes when the active one closes or leaves. */
  recent: T[];
}

export interface SplitLayout<T extends string> {
  root: LayoutNode;
  groups: Record<string, TabGroup<T>>;
  /** The group the user is working in: where a new tab opens, and what ⌘T, the
   *  status bar and "the active tab" mean. */
  focused: string;
  /** Groups by most recent focus, newest first — where focus goes when the
   *  focused group closes. */
  recent: string[];
  /** A tab asked to be shown before it was open (a row whose optimistic insert
   *  hasn't rendered yet). It is shown the moment it opens, in the group that
   *  was focused when it was asked for. */
  pending: T | null;
}

/** Where a dragged tab lands relative to a group: one of its edges (a new group
 *  on that side) or its middle (into that group). */
export type Side = "left" | "right" | "top" | "bottom";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RECENT_CAP = 12;
const FIRST_GROUP = "g0";

export function initialLayout<T extends string>(): SplitLayout<T> {
  return {
    root: { kind: "group", id: FIRST_GROUP },
    groups: { [FIRST_GROUP]: { tabs: [], active: null, recent: [] } },
    focused: FIRST_GROUP,
    recent: [FIRST_GROUP],
    pending: null,
  };
}

let groupSeq = 0;
/** A group id unique within any layout it is added to. */
function mintGroupId(layout: SplitLayout<string>): string {
  let id: string;
  do id = `g${Date.now().toString(36)}${(groupSeq++).toString(36)}`;
  while (id in layout.groups);
  return id;
}

/** The group ids in reading order (left→right, top→bottom). */
export function groupOrder(node: LayoutNode): string[] {
  return node.kind === "group" ? [node.id] : [...groupOrder(node.a), ...groupOrder(node.b)];
}

export function groupOf<T extends string>(layout: SplitLayout<T>, tab: T): string | null {
  for (const [id, g] of Object.entries(layout.groups)) if (g.tabs.includes(tab)) return id;
  return null;
}

/** Every group's active tab — what is on screen. */
export function visibleTabs<T extends string>(layout: SplitLayout<T>): T[] {
  return groupOrder(layout.root)
    .map((id) => layout.groups[id]?.active ?? null)
    .filter((t): t is T => t !== null);
}

/** The focused group's active tab — "the" active tab for a host that only
 *  needs one answer. */
export function focusedTab<T extends string>(layout: SplitLayout<T>): T | null {
  return layout.groups[layout.focused]?.active ?? null;
}

function bump<V>(list: V[], item: V): V[] {
  return [item, ...list.filter((v) => v !== item)].slice(0, RECENT_CAP);
}

export function focusGroup<T extends string>(layout: SplitLayout<T>, id: string): SplitLayout<T> {
  if (!(id in layout.groups) || (layout.focused === id && layout.recent[0] === id)) return layout;
  return { ...layout, focused: id, recent: bump(layout.recent, id) };
}

function activateIn<T extends string>(layout: SplitLayout<T>, id: string, tab: T): SplitLayout<T> {
  const g = layout.groups[id];
  const groups =
    g.active === tab && g.recent[0] === tab
      ? layout.groups
      : { ...layout.groups, [id]: { ...g, active: tab, recent: bump(g.recent, tab) } };
  return focusGroup({ ...layout, groups, pending: null }, id);
}

/** Show a tab: activate it where it is and focus that group. A tab that isn't
 *  placed yet is remembered as {@link SplitLayout.pending} and shown once it
 *  opens. */
export function selectTab<T extends string>(layout: SplitLayout<T>, tab: T): SplitLayout<T> {
  const id = groupOf(layout, tab);
  if (id === null) return layout.pending === tab ? layout : { ...layout, pending: tab };
  return activateIn(layout, id, tab);
}

/** Drop the groups with no tabs left, the sibling of each taking its place — but
 *  never the last group, which is what an empty workspace is drawn in. */
function collapse<T extends string>(layout: SplitLayout<T>): SplitLayout<T> {
  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "group") return layout.groups[node.id]?.tabs.length ? node : null;
    const a = prune(node.a);
    const b = prune(node.b);
    if (a && b) return a === node.a && b === node.b ? node : { ...node, a, b };
    return a ?? b;
  };
  const pruned = prune(layout.root);
  const root: LayoutNode = pruned ?? {
    kind: "group",
    id: layout.focused in layout.groups ? layout.focused : groupOrder(layout.root)[0],
  };
  if (root === layout.root) return layout;
  const kept = new Set(groupOrder(root));
  const groups: Record<string, TabGroup<T>> = {};
  for (const id of kept) groups[id] = layout.groups[id];
  const recent = layout.recent.filter((id) => kept.has(id));
  const focused = kept.has(layout.focused) ? layout.focused : (recent[0] ?? [...kept][0]);
  return { ...layout, root, groups, focused, recent: recent.length ? recent : [focused] };
}

/** A group without `tab`: out of its strip and its history, and the selection
 *  moved to the most recently used tab left when it was the active one. */
function without<T extends string>(g: TabGroup<T>, tab: T): TabGroup<T> {
  const tabs = g.tabs.filter((t) => t !== tab);
  const recent = g.recent.filter((t) => t !== tab);
  const active =
    g.active !== null && g.active !== tab
      ? g.active
      : (recent.find((t) => tabs.includes(t)) ?? tabs[0] ?? null);
  return { tabs, active, recent };
}

function inserted<T extends string>(tabs: T[], tab: T, index?: number): T[] {
  const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

/** Move a tab into a group at `index` (its end when omitted) and show it there.
 *  Within one group that is a reorder: `index` is a slot in the strip as drawn,
 *  so the tab's own old slot is accounted for. */
export function moveTab<T extends string>(
  layout: SplitLayout<T>,
  tab: T,
  target: string,
  index?: number,
): SplitLayout<T> {
  const source = groupOf(layout, tab);
  if (source === null || !(target in layout.groups)) return layout;
  if (source === target) {
    const g = layout.groups[target];
    const from = g.tabs.indexOf(tab);
    const to = index === undefined ? g.tabs.length - 1 : index > from ? index - 1 : index;
    const tabs = inserted(
      g.tabs.filter((t) => t !== tab),
      tab,
      to,
    );
    return activateIn(
      { ...layout, groups: { ...layout.groups, [target]: { ...g, tabs } } },
      target,
      tab,
    );
  }
  const into = layout.groups[target];
  const groups = {
    ...layout.groups,
    [source]: without(layout.groups[source], tab),
    [target]: { ...into, tabs: inserted(into.tabs, tab, index) },
  };
  return collapse(activateIn({ ...layout, groups }, target, tab));
}

/** Whether dropping `tab` on `side` of `target` would change nothing: a group's
 *  only tab split off beside itself leaves an empty group that collapses
 *  straight back. */
export function isNoopSplit<T extends string>(
  layout: SplitLayout<T>,
  tab: T,
  target: string,
): boolean {
  return groupOf(layout, tab) === target && layout.groups[target]?.tabs.length === 1;
}

/** Split `target` and put `tab` alone in a new group on `side` of it. */
export function splitTab<T extends string>(
  layout: SplitLayout<T>,
  tab: T,
  target: string,
  side: Side,
): SplitLayout<T> {
  const source = groupOf(layout, tab);
  if (source === null || !(target in layout.groups) || isNoopSplit(layout, tab, target)) {
    return layout;
  }
  const id = mintGroupId(layout);
  const leaf: LayoutNode = { kind: "group", id };
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
  const first = side === "left" || side === "top";
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.kind === "group") {
      if (node.id !== target) return node;
      return { kind: "split", dir, ratio: 0.5, a: first ? leaf : node, b: first ? node : leaf };
    }
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  const groups = {
    ...layout.groups,
    [source]: without(layout.groups[source], tab),
    [id]: { tabs: [tab], active: tab, recent: [tab] },
  };
  return collapse(activateIn({ ...layout, root: replace(layout.root), groups }, id, tab));
}

/** A split node's address: the `a`/`b` turns from the root ("" is the root). */
export type SplitPath = string;

export function nodeAt(root: LayoutNode, path: SplitPath): LayoutNode | null {
  let node: LayoutNode = root;
  for (const step of path) {
    if (node.kind !== "split") return null;
    node = step === "a" ? node.a : node.b;
  }
  return node;
}

function updateAt(
  node: LayoutNode,
  path: SplitPath,
  fn: (n: LayoutNode & { kind: "split" }) => LayoutNode,
): LayoutNode {
  if (node.kind !== "split") return node;
  if (path === "") return fn(node);
  const [step, rest] = [path[0], path.slice(1)];
  return step === "a"
    ? { ...node, a: updateAt(node.a, rest, fn) }
    : { ...node, b: updateAt(node.b, rest, fn) };
}

export function setRatio<T extends string>(
  layout: SplitLayout<T>,
  path: SplitPath,
  ratio: number,
): SplitLayout<T> {
  const node = nodeAt(layout.root, path);
  if (node?.kind !== "split" || node.ratio === ratio) return layout;
  return { ...layout, root: updateAt(layout.root, path, (n) => ({ ...n, ratio })) };
}

/** How many groups sit side by side along `dir` at their widest — the unit both
 *  equalising and the minimum-size clamp count in. */
export function span(node: LayoutNode, dir: SplitDir): number {
  if (node.kind === "group") return 1;
  const a = span(node.a, dir);
  const b = span(node.b, dir);
  return node.dir === dir ? a + b : Math.max(a, b);
}

/** Even out one divider: weighted by what is on each side, so three groups in a
 *  row come out a third each rather than a half and two quarters. */
export function equalize<T extends string>(
  layout: SplitLayout<T>,
  path: SplitPath,
): SplitLayout<T> {
  const node = nodeAt(layout.root, path);
  if (node?.kind !== "split") return layout;
  const a = span(node.a, node.dir);
  return setRatio(layout, path, a / (a + span(node.b, node.dir)));
}

export interface PlacedSplit {
  path: SplitPath;
  dir: SplitDir;
  ratio: number;
  /** The whole split node's box, as fractions of the container. */
  rect: Rect;
}

/** Every group's and every divider's box, as fractions of the container. */
export function placeLayout(root: LayoutNode): {
  groups: Map<string, Rect>;
  splits: PlacedSplit[];
} {
  const groups = new Map<string, Rect>();
  const splits: PlacedSplit[] = [];
  const walk = (node: LayoutNode, rect: Rect, path: SplitPath) => {
    if (node.kind === "group") {
      groups.set(node.id, rect);
      return;
    }
    splits.push({ path, dir: node.dir, ratio: node.ratio, rect });
    if (node.dir === "row") {
      const w = rect.w * node.ratio;
      walk(node.a, { ...rect, w }, `${path}a`);
      walk(node.b, { ...rect, x: rect.x + w, w: rect.w - w }, `${path}b`);
    } else {
      const h = rect.h * node.ratio;
      walk(node.a, { ...rect, h }, `${path}a`);
      walk(node.b, { ...rect, y: rect.y + h, h: rect.h - h }, `${path}b`);
    }
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, "");
  return { groups, splits };
}

/** The group at the top-right corner — where a host's whole-area controls (the
 *  right panel's toggle) sit, next to the panel they open. */
export function cornerGroup(root: LayoutNode): string {
  let node = root;
  while (node.kind === "split") node = node.dir === "row" ? node.b : node.a;
  return node.id;
}

/** Fit a stored layout to what is open. Idempotent, and the only place a layout
 *  learns about tabs it didn't move itself:
 *
 *  - a tab that closed leaves its group (and a group left empty collapses);
 *  - a tab that opened goes to the focused group's end — or, when it is the
 *    {@link SplitLayout.pending} one, is shown there;
 *  - a group's selection that closed falls back to its most recently used tab.
 *
 *  `open` is in the host's canonical order, which is the order new tabs are
 *  appended in. */
export function normalize<T extends string>(
  stored: SplitLayout<T>,
  open: readonly T[],
): SplitLayout<T> {
  const isOpen = new Set(open);
  const leaves = groupOrder(stored.root);
  // Each tab in one group at most, and only if it's open.
  const placed = new Set<T>();
  const groups: Record<string, TabGroup<T>> = {};
  for (const id of leaves) {
    const g = stored.groups[id] ?? { tabs: [], active: null, recent: [] };
    const tabs = g.tabs.filter((t) => isOpen.has(t) && !placed.has(t));
    for (const t of tabs) placed.add(t);
    groups[id] = { tabs, active: g.active, recent: g.recent.filter((t) => tabs.includes(t)) };
  }
  let focused = stored.focused in groups ? stored.focused : leaves[0];
  let pending = stored.pending;
  if (pending !== null && isOpen.has(pending) && !placed.has(pending)) {
    groups[focused] = { ...groups[focused], tabs: [...groups[focused].tabs, pending] };
    placed.add(pending);
  }
  const fresh = open.filter((t) => !placed.has(t));
  if (fresh.length > 0) {
    groups[focused] = { ...groups[focused], tabs: [...groups[focused].tabs, ...fresh] };
  }
  if (pending !== null && placed.has(pending)) {
    const at = leaves.find((id) => groups[id].tabs.includes(pending as T)) as string;
    groups[at] = { ...groups[at], active: pending, recent: bump(groups[at].recent, pending) };
    focused = at;
    pending = null;
  }
  for (const id of leaves) {
    const g = groups[id];
    if (g.active === null || !g.tabs.includes(g.active)) {
      groups[id] = { ...g, active: g.recent[0] ?? g.tabs[0] ?? null };
    }
  }
  const recent = stored.recent.filter((id) => id in groups);
  return collapse({
    root: stored.root,
    groups,
    focused,
    recent: recent[0] === focused ? recent : bump(recent, focused),
    pending,
  });
}

/** Whether a value read back from storage is a layout this code can trust —
 *  anything else (an older shape, a hand edit) is replaced, not repaired. */
export function isLayout(value: unknown): value is SplitLayout<string> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SplitLayout<string>>;
  if (typeof v.focused !== "string" || !Array.isArray(v.recent)) return false;
  if (typeof v.groups !== "object" || v.groups === null) return false;
  const seen = new Set<string>();
  const nodeOk = (n: unknown): boolean => {
    if (typeof n !== "object" || n === null) return false;
    const node = n as LayoutNode;
    if (node.kind === "group") {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      const g = v.groups?.[node.id];
      return !!g && Array.isArray(g.tabs) && Array.isArray(g.recent);
    }
    return (
      node.kind === "split" &&
      (node.dir === "row" || node.dir === "column") &&
      typeof node.ratio === "number" &&
      node.ratio > 0 &&
      node.ratio < 1 &&
      nodeOk(node.a) &&
      nodeOk(node.b)
    );
  };
  return nodeOk(v.root);
}
