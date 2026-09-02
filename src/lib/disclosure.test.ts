import { describe, expect, it } from "vitest";

import { isBulkToggle, toggleDisclosure } from "./disclosure";

describe("isBulkToggle", () => {
  it("reads ⌘ and Ctrl, and nothing else", () => {
    expect(isBulkToggle({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(isBulkToggle({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(isBulkToggle({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("toggleDisclosure", () => {
  const scope = ["a", "b", "c"];

  it("moves only the clicked row on a plain click", () => {
    expect([...toggleDisclosure(new Set(["a"]), "b", scope, false)].sort()).toEqual(["a", "b"]);
    expect([...toggleDisclosure(new Set(["a", "b"]), "a", scope, false)]).toEqual(["b"]);
  });

  /** The point of the gesture: whatever the clicked row is about to become, the
   *  rest becomes too — so it reads as one action, not as a special "expand all"
   *  and a separate "collapse all". */
  it("mirrors the clicked row's new state onto its scope", () => {
    expect([...toggleDisclosure(new Set(), "a", scope, true)].sort()).toEqual(["a", "b", "c"]);
    expect([...toggleDisclosure(new Set(scope), "a", scope, true)]).toEqual([]);
  });

  /** Half in, half out: the clicked row decides, not the majority. */
  it("takes its direction from the row that was clicked", () => {
    expect([...toggleDisclosure(new Set(["a"]), "a", scope, true)]).toEqual([]);
    expect([...toggleDisclosure(new Set(["a"]), "b", scope, true)].sort()).toEqual(["a", "b", "c"]);
  });

  /** A tree passes the clicked folder's own subtree, so a ⌘-click can't unfold a
   *  monorepo — and it must leave every folder outside that subtree alone. */
  it("touches nothing outside the scope it was given", () => {
    const next = toggleDisclosure(new Set(["far"]), "a", ["a", "b"], true);
    expect([...next].sort()).toEqual(["a", "b", "far"]);
    expect([...toggleDisclosure(new Set(["far", "a", "b"]), "a", ["a", "b"], true)]).toEqual([
      "far",
    ]);
  });

  /** The clicked row moves even when the scope forgot to name it. */
  it("always moves the clicked row itself", () => {
    expect([...toggleDisclosure(new Set(), "a", [], true)]).toEqual(["a"]);
  });
});
