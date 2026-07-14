import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dismissToast, showToast, type ToastVariant, toast } from "./toast";

// The store is module-level with timer-based auto-dismiss. We assert its
// observable contract through the public API: identical live toasts dedup to the
// same id; once a toast expires or is dismissed, an identical show is a new id.
describe("toast store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("dedups identical live toasts and separates by variant", () => {
    const a = showToast("error", "boom", { duration: 0 });
    expect(showToast("error", "boom", { duration: 0 })).toBe(a); // identical → same toast
    const other = showToast("success", "boom", { duration: 0 }); // different variant → new
    expect(other).not.toBe(a);
    dismissToast(a);
    dismissToast(other);
  });

  // Two unrelated failures can share an error string while carrying different
  // titles; collapsing them would show one of them under the other's heading.
  it("keeps toasts that differ only by title or duration apart", () => {
    const a = showToast("error", "Request failed", {
      title: "Couldn't create the PR",
      duration: 0,
    });
    const b = showToast("error", "Request failed", { title: "Couldn't push", duration: 0 });
    expect(b).not.toBe(a);
    expect(showToast("error", "Request failed", { title: "Couldn't push", duration: 0 })).toBe(b);

    const untitled = showToast("error", "Request failed", { duration: 0 });
    expect(untitled).not.toBe(a);
    expect(untitled).not.toBe(b);

    const shorter = showToast("error", "Request failed", { duration: 1 });
    expect(shorter).not.toBe(untitled);

    for (const id of [a, b, untitled, shorter]) dismissToast(id);
  });

  it("auto-dismisses after the duration, then an identical show is fresh", () => {
    const id = toast.success("saved", { duration: 1000 });
    vi.advanceTimersByTime(999);
    expect(toast.success("saved", { duration: 1000 })).toBe(id); // still alive
    vi.advanceTimersByTime(1001);
    expect(toast.success("saved", { duration: 1000 })).not.toBe(id); // expired → new
    dismissToast(toast.success("saved", { duration: 1000 }));
  });

  it("keeps sticky toasts (duration 0) until dismissed", () => {
    const id = toast.error("auth failed", { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(toast.error("auth failed", { duration: 0 })).toBe(id); // still present
    dismissToast(id);
    expect(toast.error("auth failed", { duration: 0 })).not.toBe(id); // gone → new
    dismissToast(toast.error("auth failed", { duration: 0 }));
  });

  it("refreshes the timer on a duplicate rather than letting the first one expire", () => {
    const id = toast.error("retrying", { duration: 1000 });
    vi.advanceTimersByTime(800);
    expect(toast.error("retrying", { duration: 1000 })).toBe(id); // dedup → same toast
    // Past the *original* deadline (1600ms in) but not the refreshed one (1800ms).
    vi.advanceTimersByTime(800);
    expect(toast.error("retrying", { duration: 1000 })).toBe(id);
    vi.advanceTimersByTime(1001);
    dismissToast(toast.error("retrying", { duration: 1000 })); // expired → a new one
  });

  // MAX_VISIBLE is 4; a fifth toast evicts one. Eviction is observed through the
  // public API: a still-live toast dedups to its original id, an evicted one comes
  // back with a fresh id. `sticky` records every id so the store starts each test
  // empty (it's module-level, shared across tests).
  describe("eviction past MAX_VISIBLE", () => {
    const shown: number[] = [];
    const sticky = (variant: ToastVariant, message: string) => {
      const id = showToast(variant, message, { duration: 0 });
      shown.push(id);
      return id;
    };
    afterEach(() => {
      for (const id of shown) dismissToast(id);
      shown.length = 0;
    });

    it("drops the oldest non-error first, keeping errors on screen", () => {
      const e1 = sticky("error", "e1");
      const s1 = sticky("success", "s1");
      sticky("success", "s2");
      sticky("error", "e2");
      sticky("error", "e3"); // 5th → evicts s1, the oldest non-error

      expect(sticky("success", "s1")).not.toBe(s1); // s1 had been dropped
      expect(sticky("error", "e1")).toBe(e1); // the oldest error is still up
    });

    it("drops an error only when nothing else is left", () => {
      const oldest = sticky("error", "a");
      for (const m of ["b", "c", "d"]) sticky("error", m);
      sticky("error", "e"); // 5th, all errors → the oldest error goes

      expect(sticky("error", "a")).not.toBe(oldest);
    });
  });
});
