import { describe, expect, it } from "vitest";

import {
  cornerGroup,
  equalize,
  focusedTab,
  groupOf,
  groupOrder,
  initialLayout,
  isLayout,
  isNoopSplit,
  moveTab,
  normalize,
  placeLayout,
  type SplitLayout,
  selectTab,
  splitTab,
  visibleTabs,
} from "./layout";

type T = string;
const open = (...tabs: T[]) => normalize(initialLayout<T>(), tabs);
const tabsOf = (l: SplitLayout<T>) => groupOrder(l.root).map((id) => l.groups[id].tabs);

describe("normalize", () => {
  it("puts what is open in the focused group, in the host's order", () => {
    const l = open("a", "b", "c");
    expect(tabsOf(l)).toEqual([["a", "b", "c"]]);
    expect(focusedTab(l)).toBe("a");
  });

  it("is idempotent — the store is written back with its own output", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    const once = normalize(l, ["a", "b", "c"]);
    expect(normalize(once, ["a", "b", "c"])).toEqual(once);
  });

  it("drops a closed tab and collapses the group it leaves empty", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    expect(tabsOf(l)).toEqual([["a"], ["b"]]);
    const closed = normalize(l, ["a"]);
    expect(tabsOf(closed)).toEqual([["a"]]);
    expect(closed.root.kind).toBe("group");
    expect(focusedTab(closed)).toBe("a");
  });

  it("falls back to the most recently used tab when the active one closes", () => {
    let l = open("a", "b", "c");
    l = selectTab(l, "c");
    l = selectTab(l, "b");
    expect(focusedTab(normalize(l, ["a", "c"]))).toBe("c");
  });

  it("places a new tab in the focused group, not the first", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    const withC = normalize(l, ["a", "b", "c"]);
    expect(tabsOf(withC)).toEqual([["a"], ["b", "c"]]);
  });

  it("shows a tab selected before it opened, once it opens", () => {
    let l = open("a");
    l = selectTab(l, "new");
    expect(normalize(l, ["a"]).pending).toBe("new");
    const opened = normalize(l, ["a", "new"]);
    expect(focusedTab(opened)).toBe("new");
    expect(opened.pending).toBeNull();
  });

  it("keeps one empty group when nothing is open", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "bottom");
    const empty = normalize(l, []);
    expect(groupOrder(empty.root)).toHaveLength(1);
    expect(focusedTab(empty)).toBeNull();
  });
});

describe("moving and splitting", () => {
  it("splits a group with the tab on the named side", () => {
    let l = open("a", "b");
    const g = groupOf(l, "a") as string;
    l = splitTab(l, "b", g, "left");
    expect(tabsOf(l)).toEqual([["b"], ["a"]]);
    expect(l.root.kind === "split" && l.root.dir).toBe("row");
    expect(focusedTab(l)).toBe("b");
    expect(visibleTabs(l)).toEqual(["b", "a"]);
  });

  it("stacks for top and bottom", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "bottom");
    expect(l.root.kind === "split" && l.root.dir).toBe("column");
    expect(tabsOf(l)).toEqual([["a"], ["b"]]);
  });

  it("refuses to split a group's only tab beside itself", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    const g = groupOf(l, "b") as string;
    expect(isNoopSplit(l, "b", g)).toBe(true);
    expect(splitTab(l, "b", g, "bottom")).toBe(l);
  });

  it("moving a group's last tab out collapses that group", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    l = moveTab(l, "b", groupOf(l, "a") as string, 0);
    expect(tabsOf(l)).toEqual([["b", "a"]]);
    expect(focusedTab(l)).toBe("b");
  });

  it("reorders within a group by strip slot", () => {
    const l = open("a", "b", "c");
    const g = groupOf(l, "a") as string;
    expect(tabsOf(moveTab(l, "a", g, 2))).toEqual([["b", "a", "c"]]);
    expect(tabsOf(moveTab(l, "c", g, 0))).toEqual([["c", "a", "b"]]);
    expect(tabsOf(moveTab(l, "a", g, 3))).toEqual([["b", "c", "a"]]);
  });

  it("a nested split survives its sibling collapsing", () => {
    let l = open("a", "b", "c");
    const g = groupOf(l, "a") as string;
    l = splitTab(l, "b", g, "right");
    l = splitTab(l, "c", groupOf(l, "b") as string, "bottom");
    expect(tabsOf(l)).toEqual([["a"], ["b"], ["c"]]);
    const closed = normalize(l, ["b", "c"]);
    expect(tabsOf(closed)).toEqual([["b"], ["c"]]);
    expect(closed.root.kind === "split" && closed.root.dir).toBe("column");
  });
});

describe("geometry", () => {
  it("places groups as fractions and finds the top-right corner", () => {
    let l = open("a", "b", "c");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    l = splitTab(l, "c", groupOf(l, "b") as string, "bottom");
    const { groups, splits } = placeLayout(l.root);
    expect(groups.get(groupOf(l, "a") as string)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(groups.get(groupOf(l, "c") as string)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(splits).toHaveLength(2);
    expect(cornerGroup(l.root)).toBe(groupOf(l, "b"));
  });

  it("equalises by what is on each side", () => {
    let l = open("a", "b", "c");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    l = splitTab(l, "c", groupOf(l, "b") as string, "right");
    // a | (b | c): the root's left side is one of three.
    const even = equalize(l, "");
    expect(even.root.kind === "split" && even.root.ratio).toBeCloseTo(1 / 3);
  });
});

describe("isLayout", () => {
  it("accepts what the operations produce and rejects anything else", () => {
    let l = open("a", "b");
    l = splitTab(l, "b", groupOf(l, "a") as string, "right");
    expect(isLayout(JSON.parse(JSON.stringify(l)))).toBe(true);
    expect(isLayout(null)).toBe(false);
    expect(
      isLayout({ root: { kind: "group", id: "x" }, groups: {}, focused: "x", recent: [] }),
    ).toBe(false);
    expect(
      isLayout({
        ...l,
        root: { kind: "split", dir: "row", ratio: 2, a: l.root, b: l.root },
      }),
    ).toBe(false);
  });
});
