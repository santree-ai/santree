import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePersistedState } from "./usePersistedState";

describe("usePersistedState", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("starts from the fallback when nothing is stored", () => {
    const { result } = renderHook(() => usePersistedState("k", "fallback"));
    expect(result.current[0]).toBe("fallback");
  });

  /** The whole point: a value set before unmount is still there on the next mount.
   *  This is what makes leaving Trees for another tab and coming back land on the
   *  same worktree instead of the all-agents overview. */
  it("restores the last value on a fresh mount", () => {
    const first = renderHook(() => usePersistedState("k", ""));
    act(() => first.result.current[1]("AK-274"));
    first.unmount();

    const second = renderHook(() => usePersistedState("k", ""));
    expect(second.result.current[0]).toBe("AK-274");
  });

  it("round-trips objects, not just strings", () => {
    const first = renderHook(() => usePersistedState<Record<string, string>>("tabs", {}));
    act(() => first.result.current[1]({ "AK-1": "file", "AK-2": "terminal" }));
    first.unmount();

    const second = renderHook(() => usePersistedState<Record<string, string>>("tabs", {}));
    expect(second.result.current[0]).toEqual({ "AK-1": "file", "AK-2": "terminal" });
  });

  /** `false`, `0` and `""` are real stored values, not "nothing stored" — a `??`
   *  on the parsed result would throw each of them away for the fallback. */
  it("restores falsy values rather than falling back", () => {
    const first = renderHook(() => usePersistedState("collapsed", true));
    act(() => first.result.current[1](false));
    first.unmount();

    expect(renderHook(() => usePersistedState("collapsed", true)).result.current[0]).toBe(false);
  });

  it("falls back when the stored entry is malformed rather than throwing", () => {
    localStorage.setItem("k", "{not json");
    expect(renderHook(() => usePersistedState("k", "safe")).result.current[0]).toBe("safe");
  });

  /** Persisting on mount would write the fallback before the user has chosen
   *  anything, making "never set" indistinguishable from "set to the default". */
  it("doesn't write anything until the value actually changes", () => {
    // Spy on the instance, not `Storage.prototype`: the test setup swaps the
    // global for a plain in-memory stand-in (see src/test/setup.ts), which never
    // inherits from `Storage` — a prototype spy silently observes nothing.
    const setItem = vi.spyOn(localStorage, "setItem");
    const { result } = renderHook(() => usePersistedState("k", "fallback"));
    expect(setItem).not.toHaveBeenCalled();

    act(() => result.current[1]("chosen"));
    expect(setItem).toHaveBeenCalledWith("k", JSON.stringify("chosen"));
    setItem.mockRestore();
  });

  /** A full disk or a privacy mode that refuses writes costs persistence, not the
   *  view — the value still has to work for the rest of the session. */
  it("survives a storage backend that throws on write", () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { result } = renderHook(() => usePersistedState("k", "a"));
    act(() => result.current[1]("b"));
    expect(result.current[0]).toBe("b");
    setItem.mockRestore();
  });

  /** The open worktree survives a route change and a reload, but a cold launch
   *  belongs on the welcome surface — so it must never reach `localStorage`,
   *  which is the store that outlives the process. */
  it("keeps a session-scoped value out of localStorage, and vice versa", () => {
    const session = renderHook(() => usePersistedState("active", "", "session"));
    act(() => session.result.current[1]("__base__"));
    session.unmount();
    expect(sessionStorage.getItem("active")).toBe(JSON.stringify("__base__"));
    expect(localStorage.getItem("active")).toBeNull();

    const local = renderHook(() => usePersistedState("repo", "", "local"));
    act(() => local.result.current[1]("santree"));
    local.unmount();
    expect(localStorage.getItem("repo")).toBe(JSON.stringify("santree"));
    expect(sessionStorage.getItem("repo")).toBeNull();
  });

  /** A cold launch is a fresh `sessionStorage` beside the same `localStorage`. */
  it("starts a session-scoped value from the fallback after a cold start", () => {
    const first = renderHook(() => usePersistedState("active", "", "session"));
    act(() => first.result.current[1]("__base__"));
    first.unmount();
    expect(renderHook(() => usePersistedState("active", "", "session")).result.current[0]).toBe(
      "__base__",
    );

    sessionStorage.clear();

    expect(renderHook(() => usePersistedState("active", "", "session")).result.current[0]).toBe("");
  });
});
