import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChangedFile, TriageTicket } from "../bindings";
import {
  applyStage,
  filterTriageQueue,
  patchSettingCache,
  queryKeys,
  useOptimisticMutation,
} from "./queries";

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

describe("useOptimisticMutation", () => {
  it("rolls back the cache to its pre-mutation snapshot and invalidates on settle when the mutation rejects", async () => {
    const qc = makeClient();
    const key = ["foo"] as const;
    qc.setQueryData(key, "before");
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    // Hold the mutationFn open so we can observe the optimistic patch before
    // rejecting it — mutationFn and onMutate are both promise-based, so
    // resolving/rejecting immediately can settle within the same microtask
    // flush `waitFor`'s first poll observes, making the intermediate state
    // impossible to assert deterministically.
    let rejectMutation!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectMutation = reject;
    });

    const { result } = renderHook(
      () =>
        useOptimisticMutation<string, void>({
          mutationFn: () => pending,
          optimistic: (client, next) => {
            const prev = client.getQueryData<string>(key);
            client.setQueryData(key, next);
            return () => client.setQueryData(key, prev);
          },
          invalidate: () => [key],
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate("after");
    });

    // onMutate patches before the mutationFn settles — observable now that
    // rejection is deferred.
    await waitFor(() => expect(qc.getQueryData(key)).toBe("after"));

    act(() => {
      rejectMutation(new Error("boom"));
    });

    // Once the mutation rejects, onError's rollback must restore the exact
    // pre-mutation snapshot — not just "some" prior value — and onSettled
    // must invalidate the keys the mutation named (the regression class from
    // the "invalidated an unregistered key" bug: this asserts the *same* key
    // instance that was cancelled is the one invalidated).
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData(key)).toBe("before");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: key });
  });

  it("cancels in-flight reads for the invalidated keys before patching (so a stale refetch can't clobber the optimistic value)", async () => {
    const qc = makeClient();
    const key = ["foo"] as const;
    qc.setQueryData(key, "before");
    const cancelSpy = vi.spyOn(qc, "cancelQueries");

    const { result } = renderHook(
      () =>
        useOptimisticMutation<string, void>({
          mutationFn: async () => {},
          optimistic: (client, next) => {
            client.setQueryData(key, next);
            return () => client.setQueryData(key, "before");
          },
          invalidate: () => [key],
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate("after");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: key });
    // Success keeps the patched value (no rollback) and still reconciles via invalidate.
    expect(qc.getQueryData(key)).toBe("after");
  });
});

describe("applyStage", () => {
  function file(path: string, staged: boolean): ChangedFile {
    return {
      path,
      oldPath: null,
      status: "Modified",
      staged,
      addLines: 1,
      delLines: 0,
      binary: false,
    };
  }

  it("stage: marks only the matching file staged", () => {
    const files = [file("a.ts", false), file("b.ts", false)];
    const result = applyStage(files, { action: "stage", path: "a.ts" });
    expect(result.find((f) => f.path === "a.ts")?.staged).toBe(true);
    expect(result.find((f) => f.path === "b.ts")?.staged).toBe(false);
  });

  it("unstage: marks only the matching file unstaged", () => {
    const files = [file("a.ts", true), file("b.ts", true)];
    const result = applyStage(files, { action: "unstage", path: "a.ts" });
    expect(result.find((f) => f.path === "a.ts")?.staged).toBe(false);
    expect(result.find((f) => f.path === "b.ts")?.staged).toBe(true);
  });

  it("discard: removes the matching file from the list", () => {
    const files = [file("a.ts", false), file("b.ts", false)];
    const result = applyStage(files, { action: "discard", path: "a.ts" });
    expect(result.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("stageAll: stages every file", () => {
    const files = [file("a.ts", false), file("b.ts", true)];
    const result = applyStage(files, { action: "stageAll" });
    expect(result.every((f) => f.staged)).toBe(true);
  });

  it("unstageAll: unstages every file", () => {
    const files = [file("a.ts", true), file("b.ts", true)];
    const result = applyStage(files, { action: "unstageAll" });
    expect(result.every((f) => !f.staged)).toBe(true);
  });
});

describe("patchSettingCache", () => {
  it("app-scope: patches the exact setting and every cached resolved-setting for that key", () => {
    const qc = makeClient();
    const settingKey = queryKeys.setting("app", "display_names");
    qc.setQueryData(settingKey, "full");
    const resolvedA = queryKeys.resolvedSetting("repo-a", "display_names");
    const resolvedB = queryKeys.resolvedSetting("repo-b", "display_names");
    const resolvedOther = queryKeys.resolvedSetting("repo-a", "trees_run_setup");
    qc.setQueryData(resolvedA, "full");
    qc.setQueryData(resolvedB, "full");
    qc.setQueryData(resolvedOther, "true");

    patchSettingCache(qc, { scope: "app", key: "display_names", value: "username" });

    expect(qc.getQueryData(settingKey)).toBe("username");
    expect(qc.getQueryData(resolvedA)).toBe("username");
    expect(qc.getQueryData(resolvedB)).toBe("username");
    // A resolved cache for a *different* key must be left untouched.
    expect(qc.getQueryData(resolvedOther)).toBe("true");
  });

  it("repo-scope: patches only the exact-scope setting, not resolved-setting caches", () => {
    const qc = makeClient();
    const settingKey = queryKeys.setting("repo:acme", "trees_run_setup");
    qc.setQueryData(settingKey, "false");
    const resolvedKey = queryKeys.resolvedSetting("acme", "trees_run_setup");
    qc.setQueryData(resolvedKey, "false");

    patchSettingCache(qc, { scope: "repo:acme", key: "trees_run_setup", value: "true" });

    expect(qc.getQueryData(settingKey)).toBe("true");
    // Only app-scoped writes are the default resolved reads fall back to.
    expect(qc.getQueryData(resolvedKey)).toBe("false");
  });

  it("rollback restores the pre-patch values for both the setting and every patched resolved cache", () => {
    const qc = makeClient();
    const settingKey = queryKeys.setting("app", "display_names");
    qc.setQueryData(settingKey, "full");
    const resolvedA = queryKeys.resolvedSetting("repo-a", "display_names");
    qc.setQueryData(resolvedA, "full");

    const rollback = patchSettingCache(qc, {
      scope: "app",
      key: "display_names",
      value: "username",
    });
    expect(qc.getQueryData(settingKey)).toBe("username");

    rollback();

    expect(qc.getQueryData(settingKey)).toBe("full");
    expect(qc.getQueryData(resolvedA)).toBe("full");
  });
});

describe("filterTriageQueue", () => {
  function ticket(id: string, opts: { mine: boolean; snoozed?: boolean }): TriageTicket {
    return {
      id,
      title: id,
      priority: "Medium",
      createdAtMs: null,
      meta: "",
      team: null,
      slaBreachMs: null,
      snoozedUntilMs: opts.snoozed ? Date.now() + 60_000 : null,
      mine: opts.mine,
    };
  }

  // One active + one snoozed ticket for each of "mine" and "theirs", so every
  // case below can assert both the mine/team split and the snoozed filter.
  const mine = ticket("mine-active", { mine: true });
  const mineSnoozed = ticket("mine-snoozed", { mine: true, snoozed: true });
  const theirs = ticket("theirs-active", { mine: false });
  const theirsSnoozed = ticket("theirs-snoozed", { mine: false, snoozed: true });
  const tickets = [mine, mineSnoozed, theirs, theirsSnoozed];

  it("mine-only (good-citizen off): shows only the viewer's active tickets, snoozed hidden", () => {
    const result = filterTriageQueue(tickets, { goodCitizen: false, showSnoozed: false });
    expect(result.visible.map((t) => t.id)).toEqual([mine.id]);
    // teamWaiting always counts others' active tickets, independent of the toggle.
    expect(result.teamWaiting).toBe(1);
  });

  it("mine-only + show snoozed: includes the viewer's own snoozed ticket, still excludes the team", () => {
    const result = filterTriageQueue(tickets, { goodCitizen: false, showSnoozed: true });
    expect(result.visible.map((t) => t.id).sort()).toEqual([mine.id, mineSnoozed.id].sort());
  });

  it("good citizen: widens to the whole team inbox (issues not assigned to you included), unconditionally", () => {
    const result = filterTriageQueue(tickets, { goodCitizen: true, showSnoozed: false });
    expect(result.visible.map((t) => t.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  it("show snoozed widens the team view too once good-citizen is showing it", () => {
    const result = filterTriageQueue(tickets, { goodCitizen: true, showSnoozed: true });
    expect(result.visible.map((t) => t.id).sort()).toEqual(tickets.map((t) => t.id).sort());
  });

  it("teamWaiting excludes the viewer's own tickets and snoozed tickets, regardless of toggles", () => {
    const result = filterTriageQueue(tickets, { goodCitizen: true, showSnoozed: true });
    expect(result.teamWaiting).toBe(1);
  });
});
