/**
 * The guard has to be two things at once, and each half has already been a bug.
 * The ref is what *blocks*: it must read true inside the click that took it, long
 * before React renders anything. The state is what *shows*: without it a launch
 * that takes seconds left every trigger looking untouched, which is exactly what
 * makes a user click again.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLaunchGuard } from "./useLaunchGuard";

describe("useLaunchGuard", () => {
  it("blocks a second take within the same click, before any render", () => {
    const { result } = renderHook(() => useLaunchGuard());

    act(() => {
      expect(result.current.take()).toBe(true);
      // Same tick, no render in between — the ref is the only thing that can
      // answer this, and it must.
      expect(result.current.take()).toBe(false);
    });
  });

  it("reports pending while a launch is held, and idle again once released", () => {
    const { result } = renderHook(() => useLaunchGuard());
    expect(result.current.pending).toBe(false);

    act(() => {
      result.current.take();
    });
    expect(result.current.pending).toBe(true);

    act(() => {
      result.current.release();
    });
    expect(result.current.pending).toBe(false);
    // Released means retryable — success and failure both come back here.
    act(() => {
      expect(result.current.take()).toBe(true);
    });
  });
});
