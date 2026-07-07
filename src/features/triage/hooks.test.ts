import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useInvestigateSelection, useKeptPanes } from "./hooks";

type Detail = { id: string };

describe("useKeptPanes", () => {
  it("prunes detailsRef for panes evicted past `max`, not just `keptPanes`", () => {
    const { result, rerender } = renderHook(
      ({ detail }: { detail: Detail | undefined }) => useKeptPanes(detail, 2),
      { initialProps: { detail: { id: "a" } as Detail | undefined } },
    );

    act(() => rerender({ detail: { id: "b" } }));
    act(() => rerender({ detail: { id: "c" } }));

    // Cap of 2: "a" fell off the front of `keptPanes` …
    expect(result.current.keptPanes).toEqual(["b", "c"]);
    // … and its detail must be pruned from the ref-backed cache too, or it
    // leaks (with any inlined images) for the life of the view.
    expect(result.current.detailFor("a")).toBeUndefined();
    expect(result.current.detailFor("b")).toEqual({ id: "b" });
    expect(result.current.detailFor("c")).toEqual({ id: "c" });
  });

  it("drops the whole cache when `resetKey` changes (e.g. switching repos)", () => {
    const { result, rerender } = renderHook(
      ({ detail, resetKey }: { detail: Detail | undefined; resetKey: string }) =>
        useKeptPanes(detail, 6, resetKey),
      { initialProps: { detail: { id: "a" } as Detail | undefined, resetKey: "repo-1" } },
    );

    act(() => rerender({ detail: { id: "b" }, resetKey: "repo-1" }));
    expect(result.current.keptPanes).toEqual(["a", "b"]);

    act(() => rerender({ detail: undefined, resetKey: "repo-2" }));

    expect(result.current.keptPanes).toEqual([]);
    expect(result.current.detailFor("a")).toBeUndefined();
    expect(result.current.detailFor("b")).toBeUndefined();
  });
});

describe("useInvestigateSelection", () => {
  it("toggles individual tickets", () => {
    const { result } = renderHook(() => useInvestigateSelection(["AK-1", "AK-2"]));
    act(() => result.current.toggle("AK-1"));
    expect(result.current.selected["AK-1"]).toBe(true);
    act(() => result.current.toggle("AK-1"));
    expect(result.current.selected["AK-1"]).toBe(false);
  });

  it("selectAll selects every eligible ticket, and toggles them all off when all are selected", () => {
    const { result, rerender } = renderHook(
      ({ eligible }: { eligible: string[] }) => useInvestigateSelection(eligible),
      { initialProps: { eligible: ["AK-1", "AK-2"] } },
    );
    act(() => result.current.selectAll());
    expect(result.current.selected).toMatchObject({ "AK-1": true, "AK-2": true });

    // A ticket that just started investigating drops out of `eligible` — the
    // remaining eligible set still counts as "all selected" and toggles off.
    act(() => rerender({ eligible: ["AK-2"] }));
    act(() => result.current.selectAll());
    expect(result.current.selected["AK-2"]).toBe(false);
  });

  it("clear empties the selection", () => {
    const { result } = renderHook(() => useInvestigateSelection(["AK-1"]));
    act(() => result.current.selectAll());
    act(() => result.current.clear());
    expect(result.current.selected).toEqual({});
  });
});
