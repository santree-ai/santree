import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatElapsed, useElapsed } from "./useElapsed";

describe("formatElapsed", () => {
  it("renders m:ss with a padded seconds field", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_400)).toBe("0:07");
    expect(formatElapsed(64_000)).toBe("1:04");
    expect(formatElapsed(750_000)).toBe("12:30");
  });

  // The readout sits next to a spinner; a negative or NaN clock would read as a
  // bug in the thing being waited on.
  it("floors at zero rather than counting backwards", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("useElapsed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts up once a second while active", () => {
    const { result } = renderHook(() => useElapsed(true));
    expect(result.current).toBe(0);

    act(() => vi.advanceTimersByTime(3_000));
    expect(formatElapsed(result.current)).toBe("0:03");
  });

  it("stays at zero when inactive, so a caller can render it unconditionally", () => {
    const { result } = renderHook(() => useElapsed(false));
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(0);
  });

  // A second run must time itself, not continue the first one's clock.
  it("restarts from zero on the next run", () => {
    const { result, rerender } = renderHook(({ active }) => useElapsed(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(4_000));
    expect(result.current).toBeGreaterThan(0);

    rerender({ active: false });
    expect(result.current).toBe(0);

    rerender({ active: true });
    act(() => vi.advanceTimersByTime(1_000));
    expect(formatElapsed(result.current)).toBe("0:01");
  });
});
