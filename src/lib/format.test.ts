import { describe, expect, it } from "vitest";

import { branchFor, diffLabel } from "./format";

describe("format helpers", () => {
  it("formats a diff with a real minus sign", () => {
    expect(diffLabel(312, 47)).toBe("+312 −47");
  });

  it("derives a lower-cased worktree branch", () => {
    expect(branchFor("AK-165")).toBe("santree/ak-165");
  });
});
