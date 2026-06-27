import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dismissToast, showToast, toast } from "./toast";

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
});
