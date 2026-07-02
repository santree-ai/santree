import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `forwardConsoleToLog` no-ops unless `__TAURI_INTERNALS__` is present on `window`
// (see logging.ts) — the tag simulates running inside the Tauri webview.
const logMock = vi.hoisted(() => ({
  debug: vi.fn().mockResolvedValue(undefined),
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-log", () => logMock);

import { forwardConsoleToLog } from "./logging";

describe("forwardConsoleToLog", () => {
  // Patches `console.*` and adds `window` listeners as a side effect — call it
  // once for the suite, since it isn't designed to be re-invoked (each call would
  // stack another set of listeners on `window`, double-forwarding events).
  beforeAll(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    forwardConsoleToLog();
  });

  beforeEach(() => {
    for (const fn of Object.values(logMock)) fn.mockClear();
  });

  afterAll(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("forwards unhandled promise rejections to the on-disk log", () => {
    const event = new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.reject(new Error("boom")).catch(() => {}),
      reason: new Error("boom"),
    });
    window.dispatchEvent(event);

    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0][0]).toContain("unhandledrejection");
    expect(logMock.error.mock.calls[0][0]).toContain("boom");
  });

  it("forwards uncaught window errors to the on-disk log", () => {
    const event = new ErrorEvent("error", {
      error: new Error("kaboom"),
      message: "kaboom",
    });
    window.dispatchEvent(event);

    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0][0]).toContain("uncaught error");
    expect(logMock.error.mock.calls[0][0]).toContain("kaboom");
  });
});
