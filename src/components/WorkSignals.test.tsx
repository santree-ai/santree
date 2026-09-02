/**
 * The cycle mark's ring is time, not scope: how far through the cycle now is,
 * from Linear's start and end dates, clamped — and nothing when Linear didn't
 * date the cycle.
 */
import { describe, expect, it } from "vitest";

import { cycleProgress } from "./WorkSignals";

const DAY = 24 * 60 * 60 * 1000;
const week = { startsAtMs: 0, endsAtMs: 7 * DAY };

describe("cycleProgress", () => {
  it("is the elapsed share of the cycle", () => {
    expect(cycleProgress(week, 2 * DAY)).toBeCloseTo(2 / 7);
  });

  it("clamps before the start and after the end", () => {
    expect(cycleProgress(week, -DAY)).toBe(0);
    expect(cycleProgress(week, 9 * DAY)).toBe(1);
  });

  it("is null without both dates, or with them the wrong way round", () => {
    expect(cycleProgress({ startsAtMs: null, endsAtMs: 7 * DAY }, DAY)).toBeNull();
    expect(cycleProgress({ startsAtMs: 0, endsAtMs: null }, DAY)).toBeNull();
    expect(cycleProgress({ startsAtMs: 7 * DAY, endsAtMs: 0 }, DAY)).toBeNull();
  });
});
