import { describe, expect, it } from "vitest";

import { clampToHunk, hunkRanges, patchLineRange, patchLines } from "./patchLines";

// A realistic GitHub `patch`: hunk body only, no `diff --git` header, with an
// added line, a removed one, an empty context line written as a bare "", and the
// no-newline marker.
const PATCH = [
  "@@ -10,5 +10,6 @@ fn main() {",
  " let a = 1;",
  "-let b = 2;",
  "+let b = 3;",
  "+let c = 4;",
  "",
  " let d = 5;",
  "\\ No newline at end of file",
].join("\n");

describe("patchLines", () => {
  it("numbers each side independently", () => {
    expect([...patchLines(PATCH, true)]).toEqual([
      [10, "let a = 1;"],
      [11, "let b = 3;"],
      [12, "let c = 4;"],
      [13, ""],
      [14, "let d = 5;"],
    ]);
    expect([...patchLines(PATCH, false)]).toEqual([
      [10, "let a = 1;"],
      [11, "let b = 2;"],
      [12, ""],
      [13, "let d = 5;"],
    ]);
  });

  it("ignores everything before the first hunk header", () => {
    const withHeader = `diff --git a/x b/x\n--- a/x\n+++ b/x\n${PATCH}`;
    expect(patchLines(withHeader, true)).toEqual(patchLines(PATCH, true));
  });

  it("restarts numbering at each hunk", () => {
    const two = `${PATCH}\n@@ -40,1 +50,1 @@\n+far away`;
    expect(patchLines(two, true).get(50)).toBe("far away");
  });
});

describe("patchLineRange", () => {
  it("returns the range in order", () => {
    expect(patchLineRange(PATCH, true, 11, 13)).toEqual(["let b = 3;", "let c = 4;", ""]);
  });

  it("is all-or-nothing when a line isn't in the patch", () => {
    // 15 is past the hunk — a prefill missing it would silently delete a line.
    expect(patchLineRange(PATCH, true, 14, 15)).toBeNull();
    expect(patchLineRange(PATCH, true, 13, 11)).toBeNull();
  });
});

describe("clampToHunk", () => {
  const TWO_HUNKS = `${PATCH}\n@@ -40,2 +50,2 @@\n one\n two`;

  it("keeps a range inside its own hunk", () => {
    expect(clampToHunk(TWO_HUNKS, true, 11, 13)).toEqual([11, 13]);
  });

  it("cuts a drag off at the hunk boundary", () => {
    // 10–14 is the first hunk; 50–51 the second. GitHub 422s on a range crossing
    // them, so the drag stops at 14 rather than posting and failing.
    expect(clampToHunk(TWO_HUNKS, true, 12, 51)).toEqual([12, 14]);
  });

  it("has no hunk to clamp to for a line off the patch", () => {
    expect(clampToHunk(TWO_HUNKS, true, 99, 100)).toBeNull();
  });
});

describe("hunkRanges", () => {
  it("bounds each hunk on the side asked for", () => {
    expect(hunkRanges(`${PATCH}\n@@ -40,1 +50,1 @@\n+far away`, true)).toEqual([
      [10, 14],
      [50, 50],
    ]);
    // The second hunk is a pure addition, so the old side sees only the first.
    expect(hunkRanges(`${PATCH}\n@@ -40,1 +50,1 @@\n+far away`, false)).toEqual([[10, 13]]);
  });
});

describe("clampToHunk direction", () => {
  it("reads a drag upwards as the same range", () => {
    expect(clampToHunk(PATCH, true, 13, 11)).toEqual([11, 13]);
  });
});
