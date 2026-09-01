/**
 * The pane set is the bind signal for both reads the registry folds.
 *
 * The process scan was already bound to it. The session rows were not, and that
 * is what left a closed tab's agent drawn under its worktree in the sidebar:
 * `useSessionStates` polls only while something is unsettled, so a quiet app
 * never re-read on its own and the row it had cached still named a live pane.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalTab } from "../terminal/orchestrator";

vi.mock("../../lib/queries", () => ({
  queryKeys: {
    sessionStates: ["session-states"] as const,
    agentProcesses: ["agent-processes"] as const,
  },
  useAgentProcesses: () => ({ data: [] }),
  useSessionStates: () => ({ data: [] }),
  useWorktreesByRepo: () => new Map(),
  useTasksByRepo: () => new Map(),
  useBaseWorktreesByRepo: () => new Map(),
}));

import { useDetectedAgents } from "./useAgents";

const pane = (refId: string): TerminalTab =>
  ({ key: refId, refId, title: refId, agent: { kind: "Claude" } }) as TerminalTab;

let invalidated: unknown[][];

function Probe({ terminals }: { terminals: TerminalTab[] }) {
  useDetectedAgents(terminals);
  return null;
}

function mount(terminals: TerminalTab[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidated = [];
  vi.spyOn(qc, "invalidateQueries").mockImplementation(((opts: { queryKey: unknown[] }) => {
    invalidated.push(opts.queryKey);
    return Promise.resolve();
  }) as never);
  const wrap = (t: TerminalTab[]): ReactNode => (
    <QueryClientProvider client={qc}>
      <Probe terminals={t} />
    </QueryClientProvider>
  );
  const view = render(wrap(terminals));
  // Assertions after a rerender are about *that* transition, not about what
  // mounting did — the mount's own scan is the subject of its own test.
  return {
    rerender: (t: TerminalTab[]) => {
      invalidated = [];
      view.rerender(wrap(t));
    },
  };
}

const sawSessions = () => invalidated.some((k) => k[0] === "session-states");
const sawProcesses = () => invalidated.some((k) => k[0] === "agent-processes");

describe("useDetectedAgents", () => {
  beforeEach(() => {
    invalidated = [];
  });

  // Mounting is not a change, and reconciling every session row against its
  // transcript is real filesystem work — four surfaces mount this hook.
  it("does not re-read the session rows just because it mounted", () => {
    mount([pane("tree:AK-1:tab:a1")]);

    expect(sawSessions()).toBe(false);
  });

  it("re-reads the session rows when a pane opens", () => {
    const { rerender } = mount([]);

    rerender([pane("tree:AK-1:tab:a1")]);

    expect(sawSessions()).toBe(true);
  });

  // The bug: closing the last agent tab is exactly when a stale row is left
  // behind, and it is also when the `ps` scan has nothing left to look at — so
  // the two reads cannot share one "only while panes exist" guard.
  it("re-reads the session rows when the last pane closes, without a ps scan", () => {
    const { rerender } = mount([pane("tree:AK-1:tab:a1")]);

    rerender([]);

    expect(sawSessions()).toBe(true);
    expect(sawProcesses()).toBe(false);
  });

  it("still scans the process table when a pane opens", () => {
    const { rerender } = mount([]);

    rerender([pane("tree:AK-1:tab:a1")]);

    expect(sawProcesses()).toBe(true);
  });

  // A re-render that hands back an equal-but-new array is not a change; the
  // fingerprint is what the effect keys on.
  it("ignores a re-render that changes nothing about the panes", () => {
    const { rerender } = mount([pane("tree:AK-1:tab:a1")]);

    rerender([pane("tree:AK-1:tab:a1")]);

    expect(sawSessions()).toBe(false);
  });
});
