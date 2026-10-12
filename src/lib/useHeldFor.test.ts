import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHeldFor } from "./useHeldFor";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useHeldFor", () => {
  it("turns true only once the condition has held for the whole wait", () => {
    const { result, rerender } = renderHook(({ on }) => useHeldFor(on, 1_000), {
      initialProps: { on: true },
    });
    act(() => void vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);

    // A break resets it at once, and the wait starts over.
    rerender({ on: false });
    expect(result.current).toBe(false);
    rerender({ on: true });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
  });
});
