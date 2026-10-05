import { describe, expect, it } from "vitest";

import { type GroupGeometry, resolveDrop, zoneAt } from "./dropZone";

/** Two groups side by side, 600px each, strips 36px tall. */
function sideBySide(): GroupGeometry[] {
  const group = (id: string, left: number): GroupGeometry => ({
    id,
    outer: { left, top: 0, width: 600, height: 636 },
    strip: { left, top: 0, width: 600, height: 36 },
    body: { left, top: 36, width: 600, height: 600 },
    tabs: [
      { index: 0, box: { left, top: 0, width: 100, height: 36 } },
      { index: 1, box: { left: left + 100, top: 0, width: 100, height: 36 } },
    ],
    count: 2,
  });
  return [group("A", 0), group("B", 601)];
}

describe("zoneAt", () => {
  const body = { left: 0, top: 0, width: 800, height: 600 };
  it("splits at the edges and moves in the middle", () => {
    expect(zoneAt(body, 10, 300)).toBe("left");
    expect(zoneAt(body, 790, 300)).toBe("right");
    expect(zoneAt(body, 400, 10)).toBe("top");
    expect(zoneAt(body, 400, 590)).toBe("bottom");
    expect(zoneAt(body, 400, 300)).toBe("center");
  });
  it("gives the corners to left and right", () => {
    expect(zoneAt(body, 5, 5)).toBe("left");
    expect(zoneAt(body, 795, 595)).toBe("right");
  });
});

describe("resolveDrop", () => {
  it("a strip inserts at the slot under the pointer", () => {
    const drop = resolveDrop(sideBySide(), "A", false, 640, 18);
    expect(drop).toMatchObject({ kind: "strip", group: "B", index: 0 });
    const after = resolveDrop(sideBySide(), "A", false, 760, 18);
    expect(after).toMatchObject({ kind: "strip", group: "B", index: 2 });
  });

  it("the edge facing the source moves rather than splits", () => {
    expect(resolveDrop(sideBySide(), "A", false, 620, 300)).toMatchObject({
      kind: "pane",
      group: "B",
      zone: "center",
    });
    // B's far edge still splits.
    expect(resolveDrop(sideBySide(), "A", false, 1190, 300)).toMatchObject({ zone: "right" });
  });

  it("a group's only tab can't be dropped on its own group", () => {
    expect(resolveDrop(sideBySide(), "A", true, 10, 300)).toBeNull();
    expect(resolveDrop(sideBySide(), "A", true, 50, 18)).toBeNull();
  });

  it("the middle of the source group is no drop at all", () => {
    expect(resolveDrop(sideBySide(), "A", false, 300, 300)).toBeNull();
    expect(resolveDrop(sideBySide(), "A", false, 10, 300)).toMatchObject({ zone: "left" });
  });

  it("a group too narrow to halve only takes the tab in", () => {
    const narrow: GroupGeometry[] = [
      {
        ...sideBySide()[1],
        body: { left: 0, top: 36, width: 300, height: 600 },
        outer: { left: 0, top: 0, width: 300, height: 636 },
        strip: { left: 0, top: 0, width: 300, height: 36 },
      },
    ];
    expect(resolveDrop(narrow, "X", false, 5, 300)).toMatchObject({ zone: "center" });
  });
});
