import { describe, expect, it } from "vitest";

import { diffLabel } from "./format";

describe("format helpers", () => {
  it("formats a diff with a real minus sign", () => {
    expect(diffLabel(312, 47)).toBe("+312 −47");
  });
});
