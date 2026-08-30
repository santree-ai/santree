/**
 * The status bar's "N agents" and the sidebar tree must be the same claim about
 * the same panes.
 *
 * They were not. Both were written against the rule in CLAUDE.md — a pane's
 * agent is decided by session row, then process table, then santree's launch
 * record — but only the registry implemented it; this segment read the launch
 * record alone. A CLI the user started by hand in a shell pane therefore
 * appeared in the tree and was missing from the count, which is the one bug a
 * status bar cannot have: it is the number people check *instead of* looking.
 *
 * Both now go through `resolvePaneAgentOwner`, and the test below is the thing
 * that keeps them there — it renders the real segment over the real hooks, with
 * only the data layer mocked, and compares its number to what
 * `buildAgentEntries` puts in the tree from the same signals.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProcess, SessionState } from "../../../bindings";
import { buildAgentEntries } from "../../../features/agents/registry";
import type { TerminalTab } from "../../../features/terminal/orchestrator";
import { paneAddress } from "../../../features/terminal/paneAddress";
import { AgentsSegment } from "./AgentsSegment";

let sessions: SessionState[] | undefined = [];
let terminals: TerminalTab[] = [];
let processes: AgentProcess[] = [];

// Only the data layer is mocked: `useDetectedAgents`, `useAttentionCount`,
// `countLive`, `buildAgentEntries` and the arbiter under them all run for real,
// because the wiring between them is exactly what drifted.
vi.mock("../../../lib/queries", () => ({
  queryKeys: { agentProcesses: ["agent-processes"] },
  useSessionStates: () => ({ data: sessions }),
  useAgentProcesses: () => ({ data: processes }),
}));

vi.mock("../../../features/terminal/TerminalsContext", () => ({
  useTerminals: () => ({ tabs: terminals }),
}));

const NOW = Date.now();
const REPO = "canary";

function session(over: Partial<SessionState> & { sessionId: string }): SessionState {
  return {
    agentKind: "Claude",
    state: "active",
    event: "UserPromptSubmit",
    cwd: "/repo",
    message: null,
    transcriptPath: null,
    updatedAtMs: NOW,
    repo: REPO,
    termKey: null,
    ...over,
  };
}

/** A pane santree launched an agent into: its surface as `refId`, undecorated,
 *  plus the launch record. */
function agentPane(termKey: string, kind: AgentProcess["agentKind"]): TerminalTab {
  return {
    key: `tab-${termKey}`,
    title: termKey,
    source: "issue",
    refId: termKey,
    cwd: `/repo/.santree/worktrees/${termKey}`,
    agent: { kind, repo: REPO, termKey },
  };
}

/** A pane santree opened as a plain shell — no launch record at all. */
function shellPane(termKey: string): TerminalTab {
  const tab = agentPane(termKey, "Claude");
  delete tab.agent;
  return tab;
}

/** One row of what `ps` sees, addressed the way the backend addresses a pane. */
function seen(
  termKey: string,
  agentKind: AgentProcess["agentKind"],
  paneAgentKind: AgentProcess["paneAgentKind"] = null,
): AgentProcess {
  return { termKey, paneAgentKind, agentKind };
}

function renderSegment() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<AgentsSegment />, { wrapper });
}

/** The number the bar is actually showing. */
function shownCount(): number {
  const label = screen.getByText(/^\d+ agents?$/);
  return Number.parseInt(label.textContent ?? "", 10);
}

/** What the sidebar tree lists as running, from the same three signals: an
 *  entry with a live PTY that hasn't finished. */
function treeCount(): number {
  const detected = new Map(
    processes.map((p) => [paneAddress(p.termKey, p.paneAgentKind), p.agentKind]),
  );
  const entries = buildAgentEntries({
    sessions: sessions ?? [],
    terminals,
    repos: [{ repo: REPO, worktrees: [], tasks: [], baseWorktree: null }],
    allRepos: [REPO],
    detected,
    nowMs: NOW,
  });
  return entries.filter((e) => e.live && e.bucket !== "done").length;
}

describe("AgentsSegment", () => {
  beforeEach(() => {
    // One of every pane the two surfaces have to agree about.
    sessions = [
      // 1. A provider that announced itself. Counted: tier 1.
      session({ sessionId: "s-1", termKey: "tree:AK-1", agentKind: "Claude" }),
      // 2. A session whose process is gone. Not running, in either place.
      session({ sessionId: "s-4", termKey: "tree:AK-4", agentKind: "Claude", state: "exited" }),
    ];
    terminals = [
      agentPane("tree:AK-1", "Claude"),
      // 3. Launched by santree, not yet announced — Codex mints its thread on
      //    the first submitted turn, so this is every fresh Codex tab. Tier 3.
      agentPane("tree:AK-2", "Codex"),
      // 4. A plain shell the user started a CLI in themselves. Tier 2 — and the
      //    pane the status bar used to miss.
      shellPane("tree:AK-3"),
      agentPane("tree:AK-4", "Claude"),
      // 5. A plain shell with nothing in it. Not an agent to anyone.
      shellPane("tree:AK-5"),
      // 6. Launched as Claude, but the user quit it and ran Codex here. One
      //    agent either way — it is the *identity* the arbiter changes.
      agentPane("tree:AK-6", "Claude"),
    ];
    processes = [
      seen("tree:AK-1", "Claude", "Claude"),
      seen("tree:AK-3", "Claude"),
      seen("tree:AK-6", "Codex", "Claude"),
    ];
  });

  it("counts every pane the tree lists, including one santree did not launch", () => {
    renderSegment();
    // AK-1 (row) + AK-2 (launch record) + AK-3 (process table) + AK-6 (either).
    // AK-4 has exited and AK-5 is a bare shell.
    expect(shownCount()).toBe(4);
    expect(shownCount()).toBe(treeCount());
  });

  it("agrees with the tree when the process table is the only thing that speaks", () => {
    // The regression in isolation: strip santree's launch records, leaving only
    // what `ps` sees. A bar reading the launch record alone shows 0 here, while
    // the tree shows three running panes.
    terminals = terminals.map((t) => {
      const bare = { ...t };
      delete bare.agent;
      return bare;
    });
    processes = [
      seen("tree:AK-1", "Claude"),
      seen("tree:AK-3", "Claude"),
      seen("tree:AK-6", "Codex"),
    ];
    // AK-1's row no longer joins a pane (the join needs the provider on the tab
    // too), so it is a detached session and the panes carry the count.
    renderSegment();
    expect(shownCount()).toBe(3);
    expect(shownCount()).toBe(treeCount());
  });

  it("agrees with the tree when nothing is running at all", () => {
    sessions = [];
    terminals = [shellPane("tree:AK-5")];
    processes = [];
    renderSegment();
    expect(shownCount()).toBe(0);
    expect(treeCount()).toBe(0);
  });

  it("shows a dash rather than a zero while the session read is in flight", () => {
    // `undefined` data is "we have not looked yet", which must not render as an
    // answer.
    sessions = undefined;
    renderSegment();
    expect(screen.getByText(/^— agents?$/)).toBeInTheDocument();
  });
});
