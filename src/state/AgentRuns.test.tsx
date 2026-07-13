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
  runSetupPref: true,
}));
vi.mock("../lib/queries", () => ({
  TREES_RUN_SETUP_KEY: "trees_run_setup",
  queryKeys: { worktrees: (repo: string) => ["worktrees", repo] },
  useBoolSetting: () => ({ value: backend.runSetupPref }),
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
});

describe("AgentRuns", () => {
  it("queues the agent launch directly when setup is off", () => {
    backend.runSetupPref = false;
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.beginRun("AK-1"));

    expect(result.current.launchAgents.has("AK-1")).toBe(true);
    expect(backend.runSetup).not.toHaveBeenCalled();
  });

  // The C2 regression: the setup run and the launch it was queued behind used to be
  // owned by the route-scoped TreesProvider. Navigating away cancelled the stream
  // handler, so `init.sh` finished server-side but the agent launch it should have
  // triggered was simply lost — no agent, no error, and a later Terminal open landed
  // on a bare shell. The run now lives at the app shell, so the chain completes.
  it("hands off to the agent launch when a task-start setup finishes", async () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.beginRun("AK-1"));
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

    act(() => result.current.beginRun("AK-1"));
    const first = channels.last;
    act(() => result.current.beginRun("AK-2"));
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

  it("streams setup output per worktree, collapsing progress redraws onto one line", () => {
    const { result } = renderHook(() => ({ runs: useAgentRuns(), lines: useSetupLines("AK-1") }), {
      wrapper,
    });
    act(() => result.current.runs.beginRun("AK-1"));

    act(() => {
      channels.last?.onmessage?.({ type: "line", text: "installing" } as SetupEvent);
      channels.last?.onmessage?.({ type: "progress", text: "50%" } as SetupEvent);
      channels.last?.onmessage?.({ type: "progress", text: "90%" } as SetupEvent);
    });

    expect(result.current.lines).toEqual(["installing", "90%"]);
  });

  it("won't start a second run for a worktree already setting up", () => {
    const { result } = renderHook(() => useAgentRuns(), { wrapper });

    act(() => result.current.beginRun("AK-1"));
    act(() => result.current.runSetup("AK-1"));

    expect(backend.runSetup).toHaveBeenCalledTimes(1);
  });
});
