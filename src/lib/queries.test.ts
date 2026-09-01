import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  ChangedFile,
  ReviewInbox,
  ReviewPr,
  SessionState,
  TriageDetail,
  TriageTicket,
} from "../bindings";

// The git mutations below are exercised end-to-end (mutate → settle → invalidate),
// so the commands they wrap are stubbed. Everything else in this file is pure.
const git = vi.hoisted(() => ({
  ok: vi.fn(async () => ({ status: "ok" as const, data: "main" })),
}));
const codex = vi.hoisted(() => ({ account: vi.fn() }));
// Captures the worktreeChanged handler so watcher tests can fire events at it.
const watcher = vi.hoisted(() => ({
  handler: undefined as ((e: { payload: { issueId: string } }) => void) | undefined,
}));
vi.mock("../bindings", () => ({
  commands: {
    commitWorktree: git.ok,
    pushWorktree: git.ok,
    pullRemoteWorktree: git.ok,
    updateBaseBranch: git.ok,
    codexAccount: codex.account,
    watchWorktrees: vi.fn(async () => ({ status: "ok" as const, data: null })),
    // The manual refresh clears the backend's Linear caches before refetching.
    linearInvalidateCaches: vi.fn(async () => null),
  },
  events: {
    worktreeChanged: {
      listen: vi.fn(async (cb: (typeof watcher)["handler"]) => {
        watcher.handler = cb;
        return () => {};
      }),
    },
  },
}));

import {
  applyStage,
  filterTriageQueue,
  newestSessionByPath,
  parseBatchSetup,
  parseLinearGroupBy,
  parseLinearScope,
  patchSettingCache,
  promptPreviewKey,
  queryKeys,
  resolveHelperAgent,
  reviewAwaitingCount,
  useCodexAccount,
  useCommitWorktree,
  useOptimisticMutation,
  usePullRemoteWorktree,
  usePushWorktree,
  useRefreshExternal,
  useUpdateBaseBranch,
  useWorktreeWatcher,
} from "./queries";

describe("reviewAwaitingCount", () => {
  const review = (
    id: string,
    viewerReview: ReviewPr["viewerReview"] = null,
    headCommittedAt = "2026-08-24T10:00:00Z",
  ) => ({ id, viewerReview, headCommittedAt }) as ReviewPr;

  it("deduplicates direct/team requests and excludes already-reviewed heads", () => {
    const direct = review("direct");
    const reviewed = review("reviewed", {
      state: "Approved",
      submittedAt: "2026-08-24T11:00:00Z",
    });
    const pushed = review(
      "pushed",
      { state: "ChangesRequested", submittedAt: "2026-08-24T09:00:00Z" },
      "2026-08-24T12:00:00Z",
    );
    const inbox = {
      mine: [],
      requested: [direct, reviewed],
      teams: [{ slug: "eng", name: "Engineering", prs: [direct, pushed] }],
      org: "acme",
      githubConnected: true,
    } satisfies ReviewInbox;

    expect(reviewAwaitingCount(inbox)).toBe(2);
  });
});

describe("resolveHelperAgent", () => {
  it("keeps helper assignments independent from the interactive Work provider", () => {
    expect(resolveHelperAgent("Codex", "Claude", "Claude")).toBe("Codex");
    expect(resolveHelperAgent("Claude", "Codex", "Codex")).toBe("Claude");
  });

  it("falls back through Work and the app default", () => {
    expect(resolveHelperAgent(null, "Claude", "Codex")).toBe("Claude");
    expect(resolveHelperAgent(null, null, "Claude")).toBe("Claude");
    expect(resolveHelperAgent(null, null, null)).toBe("Claude");
  });

  it("does not render an unknown stored provider", () => {
    expect(resolveHelperAgent("Unknown", "Claude", "Codex")).toBe("Claude");
  });
});

describe("optional provider discovery", () => {
  it("does not query an unavailable Codex provider and keeps discovery errors inline", () => {
    const qc = makeClient();
    renderHook(() => useCodexAccount(false), { wrapper: wrapper(qc) });

    expect(codex.account).not.toHaveBeenCalled();
    expect(qc.getQueryCache().find({ queryKey: queryKeys.codexAccount })?.meta).toEqual({
      silent: true,
    });
  });
});

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

  it("replays the invalidation keys of siblings whose settle was skipped (invalidate is a function of the vars)", async () => {
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    // Two calls of the same mutation site, overlapping. The first settles while
    // the second is still in flight, so its reconcile is deferred — and since
    // `invalidate` is keyed on the *vars*, the last settler must replay it or
    // `a`'s key is never invalidated (discard a.ts → stage b.ts leaves a.ts's
    // diff cache stale).
    const settle: Record<string, () => void> = {};
    const { result } = renderHook(
      () =>
        useOptimisticMutation<string, void>({
          mutationKey: ["sibling-test"],
          mutationFn: (v) =>
            new Promise<void>((resolve) => {
              settle[v] = resolve;
            }),
          invalidate: (v) => [["file", v]],
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate("a");
    });
    await waitFor(() => expect(settle.a).toBeDefined());
    act(() => {
      result.current.mutate("b");
    });
    await waitFor(() => expect(settle.b).toBeDefined());

    await act(async () => {
      settle.a();
    });
    // `b` is still in flight, so `a` deferred its reconcile to whoever settles last.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["file", "a"] });

    await act(async () => {
      settle.b();
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["file", "b"] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["file", "a"] });
  });

  it("de-dupes replayed keys, and doesn't leak a skipped sibling's keys into an unrelated later mutation", async () => {
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const settle: Record<string, () => void> = {};
    const { result } = renderHook(
      () =>
        useOptimisticMutation<string, void>({
          mutationKey: ["sibling-test-2"],
          mutationFn: (v) =>
            new Promise<void>((resolve) => {
              settle[v] = resolve;
            }),
          // Both calls share a key, so the replay must invalidate it once, not twice.
          invalidate: (v) => [["shared"], ["file", v]],
        }),
      { wrapper: wrapper(qc) },
    );

    act(() => {
      result.current.mutate("a");
    });
    await waitFor(() => expect(settle.a).toBeDefined());
    act(() => {
      result.current.mutate("b");
    });
    await waitFor(() => expect(settle.b).toBeDefined());
    await act(async () => {
      settle.a();
    });
    await act(async () => {
      settle.b();
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["file", "b"] }));
    const sharedCalls = invalidateSpy.mock.calls.filter(
      ([arg]) => JSON.stringify(arg) === JSON.stringify({ queryKey: ["shared"] }),
    );
    expect(sharedCalls).toHaveLength(1);

    // The deferred queue was drained — a later, non-overlapping call reconciles
    // only its own keys.
    invalidateSpy.mockClear();
    await act(async () => {
      const done = result.current.mutateAsync("c");
      await waitFor(() => expect(settle.c).toBeDefined());
      settle.c();
      await done;
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["file", "a"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["file", "c"] });
  });

  /** Two overlapping calls of one mutation site, each patching the same key. */
  function overlapping(qc: QueryClient, key: QueryKey) {
    const settle: Record<string, { resolve: () => void; reject: (err: Error) => void }> = {};
    const view = renderHook(
      () =>
        useOptimisticMutation<string, void>({
          mutationKey: ["overlap"],
          mutationFn: (v) =>
            new Promise<void>((resolve, reject) => {
              settle[v] = { resolve, reject };
            }),
          optimistic: (client, v) => {
            const prev = client.getQueryData<string>(key);
            client.setQueryData(key, v);
            return () => client.setQueryData(key, prev);
          },
          invalidate: () => [key],
        }),
      { wrapper: wrapper(qc) },
    );
    return { ...view, settle };
  }

  // Rollback is a snapshot-restore, and the snapshot the *first* call took predates
  // the second call's patch — so restoring it on failure used to wipe the second
  // click the user had already made (stage a.ts fails while unstage b.ts is still
  // in flight ⇒ b.ts silently flips back). The settle-time refetch is what
  // reconciles an overlap, so a failing call must leave the cache to it.
  it("an erroring call doesn't roll back over a sibling that's still in flight", async () => {
    const qc = makeClient();
    const key = ["file"] as const;
    qc.setQueryData(key, "before");
    const { result, settle } = overlapping(qc, key);

    act(() => result.current.mutate("a"));
    await waitFor(() => expect(settle.a).toBeDefined());
    act(() => result.current.mutate("b"));
    await waitFor(() => expect(settle.b).toBeDefined());
    expect(qc.getQueryData(key)).toBe("b");

    await act(async () => settle.a.reject(new Error("boom")));

    expect(qc.getQueryData(key)).toBe("b");

    // …and the survivor still reconciles with the server when it settles.
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    await act(async () => settle.b.resolve());
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: key }));
  });

  it("still rolls back a failed call once it's the only one in flight", async () => {
    const qc = makeClient();
    const key = ["file"] as const;
    qc.setQueryData(key, "before");
    const { result, settle } = overlapping(qc, key);

    act(() => result.current.mutate("a"));
    await waitFor(() => expect(settle.a).toBeDefined());
    expect(qc.getQueryData(key)).toBe("a");

    await act(async () => settle.a.reject(new Error("boom")));

    expect(qc.getQueryData(key)).toBe("before");
  });
});

describe("promptPreviewKey", () => {
  function detail(overrides: Partial<TriageDetail> = {}): TriageDetail {
    return {
      id: "ENG-1",
      title: "Title",
      priority: "Medium",
      state: "Triage",
      stateId: "s1",
      states: [],
      url: "https://linear.app/x/issue/ENG-1",
      author: "Ada",
      authorAvatarUrl: null,
      createdAtMs: null,
      labels: [],
      project: null,
      slaBreachMs: null,
      snoozedUntilMs: null,
      description: "body",
      comments: [],
      ...overrides,
    };
  }

  const body = "Fix {{ issue.title }}";

  it("is stable for identical inputs (so a re-render doesn't refetch)", () => {
    const a = promptPreviewKey("work", body, "acme", "ENG-1", detail());
    const b = promptPreviewKey("work", body, "acme", "ENG-1", detail());
    expect(a).toEqual(b);
  });

  it("changes when the draft changes", () => {
    const a = promptPreviewKey("work", body, "acme", "ENG-1", detail());
    const b = promptPreviewKey("work", `${body} now`, "acme", "ENG-1", detail());
    expect(a).not.toEqual(b);
  });

  it("changes when the sample issue changes — a refetched detail must re-render, not serve the stale preview", () => {
    const a = promptPreviewKey("work", body, "acme", "ENG-1", detail());
    const b = promptPreviewKey("work", body, "acme", "ENG-1", detail({ description: "edited" }));
    expect(a).not.toEqual(b);
  });

  it("never carries the draft text itself — the cache must not retain a copy per keystroke", () => {
    const key = promptPreviewKey("work", body, "acme", "ENG-1", detail());
    expect(key).not.toContain(body);
    // Every part stays short regardless of how big the template gets.
    const huge = promptPreviewKey("work", "x".repeat(50_000), "acme", "ENG-1", detail());
    for (const part of huge as unknown[]) {
      expect(String(part).length).toBeLessThan(32);
    }
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

  it("stage: a directory path moves everything beneath it", () => {
    const files = [file("src/a.ts", false), file("src/deep/b.ts", false), file("lib/c.ts", false)];
    const result = applyStage(files, { action: "stage", path: "src" });
    expect(result.filter((f) => f.staged).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
    ]);
  });

  it("stage: a directory never captures a sibling that merely shares its prefix", () => {
    const files = [file("src/a.ts", false), file("src2/b.ts", false)];
    const result = applyStage(files, { action: "stage", path: "src" });
    expect(result.find((f) => f.path === "src2/b.ts")?.staged).toBe(false);
  });

  it("unstage: a directory path unstages everything beneath it", () => {
    const files = [file("src/a.ts", true), file("lib/b.ts", true)];
    const result = applyStage(files, { action: "unstage", path: "src" });
    expect(result.find((f) => f.path === "src/a.ts")?.staged).toBe(false);
    expect(result.find((f) => f.path === "lib/b.ts")?.staged).toBe(true);
  });
});

describe("git mutations: what they refresh", () => {
  const repo = "acme/app";

  /** Fire a mutation and collect the query keys it invalidates on settle. */
  async function invalidatedBy<TVars>(
    hook: () => { mutate: (vars: TVars) => void; isSuccess: boolean },
    vars: TVars,
  ): Promise<string[]> {
    const qc = makeClient();
    const keys: string[] = [];
    vi.spyOn(qc, "invalidateQueries").mockImplementation((filters) => {
      keys.push(JSON.stringify(filters?.queryKey));
      return Promise.resolve();
    });
    const { result } = renderHook(hook, { wrapper: wrapper(qc) });
    act(() => result.current.mutate(vars));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return keys;
  }

  const key = (k: readonly unknown[]) => JSON.stringify(k);

  // The base entry is its own query — nothing invalidated it, so "Update main from
  // origin" left the card claiming the same divergence for a full stale window.
  it("useUpdateBaseBranch refreshes the base worktree card it just moved", async () => {
    const keys = await invalidatedBy(() => useUpdateBaseBranch(repo), "AK-1");
    expect(keys).toContain(key(queryKeys.baseWorktree(repo)));
  });

  it("usePushWorktree refreshes the base card (the base branch is pushable too)", async () => {
    const keys = await invalidatedBy(() => usePushWorktree(repo), "AK-1");
    expect(keys).toContain(key(queryKeys.baseWorktree(repo)));
  });

  it("usePullRemoteWorktree refreshes the base card", async () => {
    const keys = await invalidatedBy(() => usePullRemoteWorktree(repo), "AK-1");
    expect(keys).toContain(key(queryKeys.baseWorktree(repo)));
  });

  // A commit only touches git metadata, which the filesystem watcher deliberately
  // skips — so nothing else can drop the per-file diff cache, and a just-committed
  // file kept rendering its pre-commit diff as if it were still pending.
  it("useCommitWorktree drops the worktree's cached diffs and sources, and the base card", async () => {
    const keys = await invalidatedBy(() => useCommitWorktree(repo, "AK-1"), {
      message: "wip",
      stageAll: false,
    });
    expect(keys).toContain(key(queryKeys.worktreeFileDiffPrefix(repo, "AK-1")));
    expect(keys).toContain(key(queryKeys.worktreeFileSourcePrefix(repo, "AK-1")));
    expect(keys).toContain(key(queryKeys.worktreeStatus(repo, "AK-1")));
    expect(keys).toContain(key(queryKeys.baseWorktree(repo)));
  });
});

describe("parseBatchSetup", () => {
  it("reads the stored answer", () => {
    expect(parseBatchSetup("always")).toBe("always");
    expect(parseBatchSetup("never")).toBe("never");
  });

  // Unset (or anything unrecognized) asks rather than assuming — a batch that
  // silently ran, or silently skipped, the setup script is the worse failure.
  it("falls back to asking once", () => {
    expect(parseBatchSetup(null)).toBe("ask");
    expect(parseBatchSetup(undefined)).toBe("ask");
    expect(parseBatchSetup("")).toBe("ask");
    expect(parseBatchSetup("sometimes")).toBe("ask");
  });
});

describe("parseLinearGroupBy", () => {
  it("reads the stored nesting", () => {
    expect(parseLinearGroupBy("none")).toBe("none");
    expect(parseLinearGroupBy("project")).toBe("project");
    expect(parseLinearGroupBy("project_milestone")).toBe("project_milestone");
  });

  // Unset falls back to the shape the sidebar has always had, so this setting
  // changes nothing until somebody picks something else.
  it("falls back to milestone", () => {
    expect(parseLinearGroupBy(null)).toBe("milestone");
    expect(parseLinearGroupBy(undefined)).toBe("milestone");
    expect(parseLinearGroupBy("")).toBe("milestone");
    expect(parseLinearGroupBy("project-milestone")).toBe("milestone");
  });
});

describe("parseLinearScope", () => {
  it("requires an explicit read-write choice", () => {
    expect(parseLinearScope("read_write")).toBe("read_write");
    expect(parseLinearScope("read")).toBe("read");
    expect(parseLinearScope(null)).toBe("read");
    expect(parseLinearScope(undefined)).toBe("read");
    expect(parseLinearScope("")).toBe("read");
    expect(parseLinearScope("read,write")).toBe("read");
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

  it("app-scope: leaves a repo that has its own override alone (the override still wins)", () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.setting("repo:acme", "trees_run_setup"), "false");
    const resolvedOverridden = queryKeys.resolvedSetting("acme", "trees_run_setup");
    const resolvedPlain = queryKeys.resolvedSetting("other", "trees_run_setup");
    qc.setQueryData(resolvedOverridden, "false");
    qc.setQueryData(resolvedPlain, "false");

    patchSettingCache(qc, { scope: "app", key: "trees_run_setup", value: "true" });

    expect(qc.getQueryData(resolvedOverridden)).toBe("false");
    expect(qc.getQueryData(resolvedPlain)).toBe("true");
  });

  it("repo-scope: a non-null write always wins, so the resolved read is patched immediately", () => {
    const qc = makeClient();
    const settingKey = queryKeys.setting("repo:acme", "trees_run_setup");
    qc.setQueryData(settingKey, "false");
    const resolvedKey = queryKeys.resolvedSetting("acme", "trees_run_setup");
    qc.setQueryData(resolvedKey, "false");
    // A different repo's resolved read must not move.
    const otherRepo = queryKeys.resolvedSetting("other", "trees_run_setup");
    qc.setQueryData(otherRepo, "false");

    patchSettingCache(qc, { scope: "repo:acme", key: "trees_run_setup", value: "true" });

    expect(qc.getQueryData(settingKey)).toBe("true");
    expect(qc.getQueryData(resolvedKey)).toBe("true");
    expect(qc.getQueryData(otherRepo)).toBe("false");
  });

  it("repo-scope: clearing the override resolves back to the cached app default", () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.setting("app", "trees_run_setup"), "true");
    qc.setQueryData(queryKeys.setting("repo:acme", "trees_run_setup"), "false");
    const resolvedKey = queryKeys.resolvedSetting("acme", "trees_run_setup");
    qc.setQueryData(resolvedKey, "false");

    patchSettingCache(qc, { scope: "repo:acme", key: "trees_run_setup", value: null });

    expect(qc.getQueryData(resolvedKey)).toBe("true");
  });

  it("repo-scope: clearing an override with no cached app default leaves the resolved read to the round-trip", () => {
    const qc = makeClient();
    const resolvedKey = queryKeys.resolvedSetting("acme", "trees_run_setup");
    qc.setQueryData(resolvedKey, "false");

    patchSettingCache(qc, { scope: "repo:acme", key: "trees_run_setup", value: null });

    // Guessing here could show the wrong value; the settle-time refetch resolves it.
    expect(qc.getQueryData(resolvedKey)).toBe("false");
  });

  it("repo-scope: rollback restores the resolved read it patched", () => {
    const qc = makeClient();
    const resolvedKey = queryKeys.resolvedSetting("acme", "trees_run_setup");
    qc.setQueryData(resolvedKey, "false");

    const rollback = patchSettingCache(qc, {
      scope: "repo:acme",
      key: "trees_run_setup",
      value: "true",
    });
    expect(qc.getQueryData(resolvedKey)).toBe("true");

    rollback();

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

  // The rollback used to replay a snapshot of *every* cached resolved-setting,
  // including keys it never patched — so a failed write of one setting reverted a
  // concurrent, successful write of an unrelated one.
  it("rollback leaves an overlapping write to a different key alone", () => {
    const qc = makeClient();
    qc.setQueryData(queryKeys.resolvedSetting("acme", "display_names"), "full");
    const otherKey = queryKeys.resolvedSetting("acme", "work_model");
    qc.setQueryData(otherKey, "opus");

    const rollbackNames = patchSettingCache(qc, {
      scope: "app",
      key: "display_names",
      value: "username",
    });
    // A second setting is written (and lands) while the first is still in flight.
    patchSettingCache(qc, { scope: "app", key: "work_model", value: "sonnet" });

    rollbackNames();

    expect(qc.getQueryData(queryKeys.resolvedSetting("acme", "display_names"))).toBe("full");
    expect(qc.getQueryData(otherKey)).toBe("sonnet");
  });

  // `setQueryData(key, undefined)` is a no-op in TanStack Query, so restoring "it
  // wasn't cached" by writing the snapshot back left the optimistic value in place
  // — a failed write of a never-read setting stuck around as if it had succeeded.
  it("rollback removes an entry that wasn't cached before the patch", () => {
    const qc = makeClient();
    const settingKey = queryKeys.setting("app", "work_model");

    const rollback = patchSettingCache(qc, { scope: "app", key: "work_model", value: "opus" });
    expect(qc.getQueryData(settingKey)).toBe("opus");

    rollback();

    expect(qc.getQueryData(settingKey)).toBeUndefined();
  });
});

describe("newestSessionByPath", () => {
  const at = (cwd: string, sessionId: string, updatedAtMs: number | null): SessionState => ({
    agentKind: "Claude",
    sessionId,
    state: "active",
    event: "Stop",
    cwd,
    message: null,
    transcriptPath: null,
    updatedAtMs,
    repo: "canary",
    termKey: null,
  });

  // A worktree can host several Claude tabs. The backend hands them over newest
  // first, but the correlation must not *depend* on that: pick the newest.
  it("keeps the most recently updated session for each worktree path", () => {
    const map = newestSessionByPath([
      at("/wt/a", "old", 1),
      at("/wt/a", "new", 5),
      at("/wt/b", "other", 3),
    ]);

    expect(map.get("/wt/a")?.sessionId).toBe("new");
    expect(map.get("/wt/b")?.sessionId).toBe("other");
    expect(map.size).toBe(2);
  });

  it("falls back to the backend's order when timestamps tie or are missing", () => {
    const map = newestSessionByPath([at("/wt/a", "first", null), at("/wt/a", "second", null)]);

    expect(map.get("/wt/a")?.sessionId).toBe("first");
  });
});

describe("filterTriageQueue", () => {
  function ticket(id: string, opts: { mine: boolean; snoozed?: boolean }): TriageTicket {
    return {
      id,
      title: id,
      priority: "Medium",
      estimate: null,
      project: null,
      projectColor: null,
      projectIcon: null,
      projectTargetDate: null,
      dueDate: null,
      sortOrder: null,
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

describe("useWorktreeWatcher: single-flight invalidation", () => {
  // Each invalidation wave issues 6 invalidateQueries calls (status, files,
  // diff prefix, source prefix, worktrees list, base worktree).
  const WAVE = 6;

  /** Render the hook with an invalidateQueries spy whose promises resolve only
   *  when the test says so — a stand-in for slow `git status` fetches. */
  function mount() {
    const qc = makeClient();
    let pending: Array<() => void> = [];
    const spy = vi
      .spyOn(qc, "invalidateQueries")
      .mockImplementation(() => new Promise<void>((res) => pending.push(res)) as Promise<void>);
    const view = renderHook(() => useWorktreeWatcher("repo"), { wrapper: wrapper(qc) });
    const flush = async () => {
      const batch = pending;
      pending = [];
      for (const res of batch) res();
      // Let the drain loop's `await Promise.all` settle and issue the next wave.
      await act(async () => {});
    };
    const fire = (issueId: string) => watcher.handler?.({ payload: { issueId } });
    return { spy, fire, flush, unmount: view.unmount };
  }

  it("a burst of events during an in-flight wave collapses to one trailing pass, not one wave per event", async () => {
    const { spy, fire, flush, unmount } = mount();
    fire("AK-1");
    expect(spy).toHaveBeenCalledTimes(WAVE);

    // Checkout churn: four more events land while the first wave is in flight.
    fire("AK-1");
    fire("AK-1");
    fire("AK-1");
    fire("AK-1");
    expect(spy).toHaveBeenCalledTimes(WAVE); // no new wave started

    await flush(); // first wave settles → exactly one trailing pass
    expect(spy).toHaveBeenCalledTimes(2 * WAVE);

    await flush(); // trailing pass settles with nothing dirty → drain ends
    expect(spy).toHaveBeenCalledTimes(2 * WAVE);

    // Drain state is reset: a fresh event starts a fresh wave.
    fire("AK-1");
    expect(spy).toHaveBeenCalledTimes(3 * WAVE);
    unmount();
  });

  it("passes cancelRefetch:false on every invalidation, so an in-flight fetch is never cancelled-and-refired", async () => {
    const { spy, fire, flush, unmount } = mount();
    fire("AK-1");
    await flush();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) {
      expect(call[1]).toMatchObject({ cancelRefetch: false });
    }
    unmount();
  });

  it("single-flight is per worktree: a different worktree's event starts its own wave immediately", () => {
    const { spy, fire, unmount } = mount();
    fire("AK-1");
    expect(spy).toHaveBeenCalledTimes(WAVE);
    fire("AK-2"); // not blocked behind AK-1's in-flight wave
    expect(spy).toHaveBeenCalledTimes(2 * WAVE);
    unmount();
  });
});

describe("useRefreshExternal", () => {
  const key = (k: readonly unknown[]) => JSON.stringify(k);

  /** Click the refresh and collect the query keys it invalidated. */
  function refreshed(): string[] {
    const qc = makeClient();
    const keys: string[] = [];
    vi.spyOn(qc, "invalidateQueries").mockImplementation((filters) => {
      keys.push(JSON.stringify(filters?.queryKey));
      return Promise.resolve();
    });
    const { result } = renderHook(() => useRefreshExternal(), { wrapper: wrapper(qc) });
    act(() => result.current.refresh());
    return keys;
  }

  // Nothing polls Linear/GitHub and window-focus refetching is off, so this hook
  // is the *only* way a just-created ticket or PR reaches the UI before the view
  // remounts past its stale window. A key missing here is silently unrefreshable.
  it("invalidates every external-service read", async () => {
    const keys = refreshed();
    for (const prefix of [
      queryKeys.tasksPrefix,
      queryKeys.triageTicketsPrefix,
      queryKeys.triageDetailPrefix,
      queryKeys.triageSchedulePrefix,
      queryKeys.reviewsPrefix,
      queryKeys.worktreePrsPrefix,
      queryKeys.mergeQueuePrefix,
      queryKeys.prDetailPrefix,
      queryKeys.prTicketsPrefix,
    ]) {
      expect(keys).toContain(key(prefix));
    }

    // The org-keyed backend cache must be dropped too, or a refresh inside its
    // TTL is served the very list the user is refreshing to get past.
    const { commands } = await import("../bindings");
    expect(commands.linearInvalidateCaches).toHaveBeenCalled();
  });

  // Local git state has a filesystem watcher; re-pulling it here would duplicate
  // that watcher's work on every click (and on every ⌘⇧R held down).
  it("leaves locally-sourced reads alone", () => {
    const keys = refreshed();
    expect(keys).not.toContain(key(queryKeys.worktrees("acme/app")));
    expect(keys).not.toContain(key(queryKeys.settings));
    expect(keys.some((k) => k.includes("worktree-status"))).toBe(false);
  });

  // The keys are prefixes, not repo-scoped: only what's rendered refetches, so
  // one click covers every repo the cross-repo Agents view is showing.
  it("invalidates by prefix, so no key carries a repo", () => {
    for (const k of refreshed()) expect(JSON.parse(k)).toHaveLength(1);
  });
});
