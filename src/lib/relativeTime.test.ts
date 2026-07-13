import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRelativeTime, formatSla, useLiveNow } from "./relativeTime";

const T0 = new Date("2026-07-13T12:00:00Z").getTime();

describe("useLiveNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("ticks every 30s and shares one interval across consumers", () => {
    const a = renderHook(() => useLiveNow());
    const b = renderHook(() => useLiveNow());
    expect(a.result.current).toBe(T0);
    expect(vi.getTimerCount()).toBe(1); // shared, not one per consumer

    act(() => void vi.advanceTimersByTime(30_000));
    expect(a.result.current).toBe(T0 + 30_000);
    expect(b.result.current).toBe(T0 + 30_000);

    // The interval only stops once the *last* consumer is gone.
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-reads the clock when the first consumer resubscribes", () => {
    renderHook(() => useLiveNow()).unmount(); // clock now frozen at T0

    // An hour passes with nothing mounted (no interval running, so no tick).
    vi.setSystemTime(T0 + 3_600_000);

    // Coming back must not serve the frozen snapshot for up to another 30s.
    const { result } = renderHook(() => useLiveNow());
    expect(result.current).toBe(T0 + 3_600_000);
  });
});

describe("formatRelativeTime", () => {
  const ago = (ms: number) => formatRelativeTime(T0 - ms, T0);

  it("scales the unit with the elapsed time", () => {
    expect(ago(30_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5m ago");
    expect(ago(2 * 3_600_000)).toBe("2h ago");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
    expect(ago(14 * 86_400_000)).toBe("2w ago");
    expect(ago(90 * 86_400_000)).toBe("3mo ago");
    expect(ago(800 * 86_400_000)).toBe("2y ago");
  });

  it("clamps a future timestamp (clock skew) to 'just now'", () => {
    expect(formatRelativeTime(T0 + 60_000, T0)).toBe("just now");
  });
});

describe("formatSla", () => {
  it("counts down, then reports the breach", () => {
    expect(formatSla(null, T0)).toBeNull();
    expect(formatSla(T0 + 45 * 60_000, T0)).toBe("SLA in 45m");
    expect(formatSla(T0 + 3 * 3_600_000, T0)).toBe("SLA in 3h");
    expect(formatSla(T0 + 30 * 3_600_000, T0)).toBe("SLA in 1d 6h");
    expect(formatSla(T0 - 1, T0)).toBe("SLA breached");
  });
});
