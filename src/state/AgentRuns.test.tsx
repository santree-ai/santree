import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../bindings";

/** The Channel the streaming setup command is handed — captured so the test can
 *  play backend events into it. */
const channels = vi.hoisted(() => ({
  last: null as { onmessage?: (e: StreamEvent) => void } | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: StreamEvent) => void;
    constructor() {
      channels.last = this;
    }
  },
}));

const backend = vi.hoisted(() => ({
  runSetup: vi.fn(async () => ({ status: "ok" as const, data: null })),
  /** What the *imperative* read of `trees_run_setup` resolves to — `beginRun` never
   *  reads the hook's value, precisely because it can't tell "off" from "loading". */
  runSetupPref: true,
  /** Whether the hook has resolved. `beginRun` must behave the same either way. */
  prefFetched: true,
}));
vi.mock("../lib/queries", () => ({
  TREES_RUN_SETUP_KEY: "trees_run_setup",
  queryKeys: { worktrees: (repo: string) => ["worktrees", repo] },
  useResolvedBoolSetting: () => ({
    value: backend.prefFetched && backend.runSetupPref,
    isFetched: backend.prefFetched,
  }),
  ensureResolvedSetting: async () => (backend.runSetupPref ? "true" : "false"),
}));
vi.mock("../bindings", () => ({ commands: { runWorktreeSetupStreamed: backend.runSetup } }));
vi.mock("./AppContext", () => ({ useApp: () => ({ activeRepo: "acme/app" }) }));

import { AgentRunsProvider, useAgentRuns } from "./AgentRuns";
import { getRun, resetAll, setupRunKey } from "./streamRuns";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AgentRunsProvider>{children}</AgentRunsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  resetAll();
  channels.last = null;
  backend.runSetup.mockClear();
  backend.runSetupPref = true;
  backend.prefFetched = true;
});

/** `beginRun` resolves the setup preference before it decides, so the decision
 *  lands a microtask later — flush it. */
async function beginRun(run: () => void) {
  await act(async () => {
    run();
  });
}

describe("AgentRuns", () => {
  it("queues the agent launch directly when setup is off", async () => {
    backend.runSetupPref = false;
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));

    expect(result.current.launchAgents.has("AK-1")).toBe(true);
    expect(backend.runSetup).not.toHaveBeenCalled();
  });

  // The guard that wasn't: `runSetupOnStart` is `data === "true"`, so it reads false
  // both when setup is off and when the setting simply hasn't loaded — and that
  // window reopens on every repo switch (the resolved read is keyed by repo). A
  // launch inside it used to skip `init.sh` outright and drop the agent into an
  // unprepared worktree. The decision now waits for the real value.
  it("runs setup for a launch that fires before the preference has loaded", async () => {
    backend.prefFetched = false;
    backend.runSetupPref = true;
    const { result } = renderHook(() => useAgentRuns(), { wrapper });
    expect(result.current.runSetupOnStart).toBe(false); // the hook can't tell yet

    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));

    expect(backend.runSetup).toHaveBeenCalledTimes(1);
    expect(result.current.isInitialSetup("AK-1")).toBe(true);
    expect(result.current.launchAgents.has("AK-1")).toBe(false); // setup first
  });

  // "Never" / "Always" for a multi-task launch: one answer, applied to every
  // worktree in the batch when its run begins — which happens later, and elsewhere
  // (the off-screen launcher), so it can't be passed down the call stack.
  it("prefers a batch's planned setup answer over the preference", async () => {
    backend.runSetupPref = true;
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.planSetup(["AK-1", "AK-2"], false));
    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));

    expect(backend.runSetup).not.toHaveBeenCalled();
    expect(result.current.launchAgents.has("AK-1")).toBe(true);

    // The plan is per worktree, so the batch's other ticket honours it too…
    await beginRun(() => result.current.beginRun("AK-2", "tab-AK-2"));
    expect(backend.runSetup).not.toHaveBeenCalled();

    // …and a worktree outside the batch still follows the preference.
    await beginRun(() => result.current.beginRun("AK-9", "tab-AK-9"));
    expect(backend.runSetup).toHaveBeenCalledTimes(1);
    expect(result.current.isInitialSetup("AK-9")).toBe(true);
  });

  it("runs setup for every worktree in a batch that answered yes", async () => {
    backend.runSetupPref = false; // the single-launch preference says no…
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.planSetup(["AK-1", "AK-2"], true)); // …the batch says yes
    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));
    await beginRun(() => result.current.beginRun("AK-2", "tab-AK-2"));

    expect(backend.runSetup).toHaveBeenCalledTimes(2);
    expect(result.current.isInitialSetup("AK-1")).toBe(true);
    expect(result.current.isInitialSetup("AK-2")).toBe(true);
  });

  // The C2 regression: the setup run and the launch it was queued behind used to be
  // owned by the route-scoped TreesProvider. Navigating away cancelled the stream
  // handler, so `init.sh` finished server-side but the agent launch it should have
  // triggered was simply lost — no agent, no error, and a later Terminal open landed
  // on a bare shell. The run now lives at the app shell, so the chain completes.
  it("hands off to the agent launch when a task-start setup finishes", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));
    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.isInitialSetup("AK-1")).toBe(true);
    expect(result.current.launchAgents.has("AK-1")).toBe(false); // not yet — setup first

    act(() => channels.last?.onmessage?.({ type: "done", ok: true } as StreamEvent));

    await waitFor(() => expect(result.current.isSettingUp("AK-1")).toBe(false));
    expect(result.current.launchAgents.has("AK-1")).toBe(true);
  });

  // A manual "Run setup" is not a task start — it must not launch an agent, and it
  // must not disturb the terminal that's already running in that worktree.
  it("does not launch an agent when a manual setup re-run finishes", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.runSetup("AK-1"));
    expect(result.current.isInitialSetup("AK-1")).toBe(false);

    act(() => channels.last?.onmessage?.({ type: "done", ok: true } as StreamEvent));

    await waitFor(() => expect(result.current.isSettingUp("AK-1")).toBe(false));
    expect(result.current.launchAgents.has("AK-1")).toBe(false);
  });

  // Runs are keyed by worktree id, not a single slot. Global ownership is what makes
  // concurrent runs real (two background launches start together), and the old single
  // `setupFor` slot would have let the second clobber the first's queued launch.
  it("keeps concurrent setup runs independent", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));
    const first = channels.last;
    await beginRun(() => result.current.beginRun("AK-2", "tab-AK-2"));
    const second = channels.last;

    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.isSettingUp("AK-2")).toBe(true);
    expect(first).not.toBe(second);

    act(() => second?.onmessage?.({ type: "done", ok: true } as StreamEvent));
    await waitFor(() => expect(result.current.launchAgents.has("AK-2")).toBe(true));
    // AK-1's run is untouched — its launch is still pending behind its own setup.
    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.launchAgents.has("AK-1")).toBe(false);

    act(() => first?.onmessage?.({ type: "done", ok: true } as StreamEvent));
    await waitFor(() => expect(result.current.launchAgents.has("AK-1")).toBe(true));
  });

  // Output goes to the shared `streamRuns` store, keyed per worktree — not into
  // this context, whose consumers must not re-render once per chunk of a chatty
  // `npm install`. Chunks are kept raw and in order for the pane to replay.
  it("streams setup output into the shared store, keyed by worktree", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });
    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));

    act(() => {
      channels.last?.onmessage?.({ type: "chunk", text: "installing\r\n" } as StreamEvent);
      channels.last?.onmessage?.({ type: "chunk", text: "\x1b[32m50%\x1b[0m\r" } as StreamEvent);
    });

    const run = getRun(setupRunKey("AK-1"));
    expect(run.chunks).toEqual(["installing\r\n", "\x1b[32m50%\x1b[0m\r"]);
    expect(run.running).toBe(true);
    expect(getRun(setupRunKey("AK-2")).chunks).toEqual([]);
  });

  it("won't start a second run for a worktree already setting up", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1", "tab-AK-1"));
    act(() => result.current.runSetup("AK-1"));

    expect(backend.runSetup).toHaveBeenCalledTimes(1);
  });
});
