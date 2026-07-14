import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupEvent } from "../bindings";

/** The Channel the streaming setup command is handed — captured so the test can
 *  play backend events into it. */
const channels = vi.hoisted(() => ({
  last: null as { onmessage?: (e: SetupEvent) => void } | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (e: SetupEvent) => void;
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

import { AgentRunsProvider, useAgentRuns, useSetupLines } from "./AgentRuns";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AgentRunsProvider>{children}</AgentRunsProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
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

    await beginRun(() => result.current.beginRun("AK-1"));

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

    await beginRun(() => result.current.beginRun("AK-1"));

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
    await beginRun(() => result.current.beginRun("AK-1"));

    expect(backend.runSetup).not.toHaveBeenCalled();
    expect(result.current.launchAgents.has("AK-1")).toBe(true);

    // The plan is per worktree, so the batch's other ticket honours it too…
    await beginRun(() => result.current.beginRun("AK-2"));
    expect(backend.runSetup).not.toHaveBeenCalled();

    // …and a worktree outside the batch still follows the preference.
    await beginRun(() => result.current.beginRun("AK-9"));
    expect(backend.runSetup).toHaveBeenCalledTimes(1);
    expect(result.current.isInitialSetup("AK-9")).toBe(true);
  });

  it("runs setup for every worktree in a batch that answered yes", async () => {
    backend.runSetupPref = false; // the single-launch preference says no…
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.planSetup(["AK-1", "AK-2"], true)); // …the batch says yes
    await beginRun(() => result.current.beginRun("AK-1"));
    await beginRun(() => result.current.beginRun("AK-2"));

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

    await beginRun(() => result.current.beginRun("AK-1"));
    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.isInitialSetup("AK-1")).toBe(true);
    expect(result.current.launchAgents.has("AK-1")).toBe(false); // not yet — setup first

    act(() => channels.last?.onmessage?.({ type: "done", ok: true } as SetupEvent));

    await waitFor(() => expect(result.current.isSettingUp("AK-1")).toBe(false));
    expect(result.current.launchAgents.has("AK-1")).toBe(true);
  });

  // A manual "Run setup" is not a task start — it must not launch an agent, and it
  // must not disturb the terminal that's already running in that worktree.
  it("does not launch an agent when a manual setup re-run finishes", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.runSetup("AK-1"));
    expect(result.current.isInitialSetup("AK-1")).toBe(false);

    act(() => channels.last?.onmessage?.({ type: "done", ok: true } as SetupEvent));

    await waitFor(() => expect(result.current.isSettingUp("AK-1")).toBe(false));
    expect(result.current.launchAgents.has("AK-1")).toBe(false);
  });

  // Runs are keyed by worktree id, not a single slot. Global ownership is what makes
  // concurrent runs real (two background launches start together), and the old single
  // `setupFor` slot would have let the second clobber the first's queued launch.
  it("keeps concurrent setup runs independent", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1"));
    const first = channels.last;
    await beginRun(() => result.current.beginRun("AK-2"));
    const second = channels.last;

    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.isSettingUp("AK-2")).toBe(true);
    expect(first).not.toBe(second);

    act(() => second?.onmessage?.({ type: "done", ok: true } as SetupEvent));
    await waitFor(() => expect(result.current.launchAgents.has("AK-2")).toBe(true));
    // AK-1's run is untouched — its launch is still pending behind its own setup.
    expect(result.current.isSettingUp("AK-1")).toBe(true);
    expect(result.current.launchAgents.has("AK-1")).toBe(false);

    act(() => first?.onmessage?.({ type: "done", ok: true } as SetupEvent));
    await waitFor(() => expect(result.current.launchAgents.has("AK-1")).toBe(true));
  });

  it("streams setup output per worktree, collapsing progress redraws onto one line", async () => {
    const { result } = renderHook(() => ({ runs: useAgentRuns(), lines: useSetupLines("AK-1") }), {
      wrapper,
    });
    await beginRun(() => result.current.runs.beginRun("AK-1"));

    act(() => {
      channels.last?.onmessage?.({ type: "line", text: "installing" } as SetupEvent);
      channels.last?.onmessage?.({ type: "progress", text: "50%" } as SetupEvent);
      channels.last?.onmessage?.({ type: "progress", text: "90%" } as SetupEvent);
    });

    expect(result.current.lines).toEqual(["installing", "90%"]);
  });

  it("won't start a second run for a worktree already setting up", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    await beginRun(() => result.current.beginRun("AK-1"));
    act(() => result.current.runSetup("AK-1"));

    expect(backend.runSetup).toHaveBeenCalledTimes(1);
  });
});
