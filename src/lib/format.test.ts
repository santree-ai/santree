import { describe, expect, it } from "vitest";

import { diffLabel, formatCompact } from "./format";

describe("format helpers", () => {
  it("formats a diff with a real minus sign", () => {
    expect(diffLabel(312, 47)).toBe("+312 −47");
  });

  it("formats a compact count, dropping a trailing .0", () => {
    expect(formatCompact(null)).toBe("0");
    expect(formatCompact(812)).toBe("812");
    expect(formatCompact(51_200)).toBe("51.2k");
    expect(formatCompact(2_000_000)).toBe("2M");
    expect(formatCompact(3_400_000_000)).toBe("3.4B");
  });

  it("carries at a unit boundary instead of rendering '1000k'", () => {
    expect(formatCompact(999_950)).toBe("1M");
    expect(formatCompact(999_999)).toBe("1M");
    expect(formatCompact(999_999_950)).toBe("1B");
  });
});
