import { describe, expect, it } from "vitest";

import {
  diffLabel,
  formatCompact,
  formatCostPrecise,
  formatUntil,
  formatUntilPrecise,
} from "./format";

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

describe("formatCostPrecise", () => {
  /** The whole point: a sub-cent spend at two decimals is "$0.00", which a
   *  reader takes as free. Four decimals keeps a real number visible. */
  it("keeps four decimals below a cent", () => {
    expect(formatCostPrecise(0.0037)).toBe("$0.0037");
    expect(formatCostPrecise(0.00004)).toBe("$0.0000");
    expect(formatCostPrecise(0.0099)).toBe("$0.0099");
  });

  it("uses two decimals from a cent up, with thousands separators", () => {
    expect(formatCostPrecise(0.41)).toBe("$0.41");
    expect(formatCostPrecise(0.01)).toBe("$0.01");
    expect(formatCostPrecise(1204)).toBe("$1,204.00");
  });

  /** An unpriced model sends `null`, not `0` — and the caller must render
   *  nothing rather than claim the work was free. */
  it("omits the cost entirely when there is no price", () => {
    expect(formatCostPrecise(null)).toBeNull();
    expect(formatCostPrecise(undefined)).toBeNull();
    expect(formatCostPrecise(0)).toBe("$0");
  });
});

describe("countdown formatters", () => {
  const now = 1_700_000_000_000;

  /** The reason the precise one exists: GitHub's search pool refills every 60
   *  seconds, so the coarse formatter can only ever answer "1m" or "now" about
   *  it — and rounds 40 seconds UP to a minute, which reads as longer than the
   *  wait actually is. */
  it("keeps sub-minute waits in seconds where the coarse one cannot", () => {
    expect(formatUntilPrecise(now + 40_000, now)).toBe("40s");
    expect(formatUntil(now + 40_000, now)).toBe("1m");
    expect(formatUntilPrecise(now + 1_000, now)).toBe("1s");
  });

  it("hands anything over a minute back to the coarse formatter", () => {
    expect(formatUntilPrecise(now + 90_000, now)).toBe("2m");
    expect(formatUntilPrecise(now + 3_600_000, now)).toBe("1h");
  });

  it("says now once the window has passed", () => {
    expect(formatUntilPrecise(now, now)).toBe("now");
    expect(formatUntilPrecise(now - 5_000, now)).toBe("now");
  });
});
