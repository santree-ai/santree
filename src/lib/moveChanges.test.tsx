import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { MoveChanges } from "../bindings";
import {
  type MoveRemainingChangesVars,
  queryKeys,
  useMoveRemainingChanges,
  usePendingWorktreeMoves,
} from "./queries";

const command = vi.hoisted(() => vi.fn());
vi.mock("../bindings", () => ({ commands: { moveRemainingChanges: command }, events: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const vars: MoveRemainingChangesVars = {
  runSetup: true,
  id: "move-1",
  branch: "child",
  ticketId: "AK-451",
  destination: { id: "split-1", baseBranch: "parent", project: "Knowledge" },
};

for (const outcome of ["success", "error"] as const) {
  it(`keeps the child pending through reconciliation on ${outcome}, even after the form unmounts`, async () => {
    const move = deferred<
      { status: "ok"; data: MoveChanges } | { status: "error"; error: string }
    >();
    const refresh = deferred<unknown[]>();
    command.mockReturnValueOnce(move.promise);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = queryKeys.worktrees("repo-a");
    qc.setQueryData(key, []);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const fetch = vi.fn(() => refresh.promise);
    const sidebar = renderHook(
      () => {
        useQuery({ queryKey: key, queryFn: fetch, staleTime: Infinity });
        return usePendingWorktreeMoves();
      },
      { wrapper },
    );
    const onCreated = vi.fn();
    const form = renderHook(() => useMoveRemainingChanges("repo-a", "parent-id", onCreated), {
      wrapper,
    });
    act(() => form.result.current.mutate(vars));
    await waitFor(() =>
      expect(sidebar.result.current).toEqual([
        {
          repo: "repo-a",
          id: "split-1",
          title: "child",
          ticketId: "AK-451",
          project: "Knowledge",
          agent: null,
          baseBranch: "parent",
          holdUntilSettled: true,
        },
      ]),
    );
    expect(command).toHaveBeenCalledWith("repo-a", "move-1", "child", "AK-451");
    // An early watcher read must not turn a partially populated child into a ready worktree.
    act(() => qc.setQueryData(key, [{ id: "split-1" }]));
    expect(sidebar.result.current).toHaveLength(1);
    form.unmount();
    act(() =>
      move.resolve(
        outcome === "success"
          ? { status: "ok", data: { worktreeId: "split-1", completed: true } as MoveChanges }
          : { status: "error", error: "Move failed; recovery stash preserved" },
      ),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(onCreated).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(sidebar.result.current).toHaveLength(1);
    act(() => refresh.resolve(outcome === "success" ? [{ id: "split-1" }] : []));
    await waitFor(() => expect(sidebar.result.current).toEqual([]));
    expect(qc.getQueryData(key)).toEqual(outcome === "success" ? [{ id: "split-1" }] : []);
    sidebar.unmount();
    qc.clear();
  });
}
