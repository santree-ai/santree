/**
 * How many agents are running, and how many of them are blocked on you.
 *
 * With the top tabs gone this is the only door left to the cross-repo agents
 * overview, so it is always rendered — including while the session read is still
 * in flight, where it shows a dash rather than the "0 agents" that would read as
 * an answer. The count of agents needing you is the one number in the bar that
 * earns a color: it is the only thing here that goes stale by being ignored.
 *
 * Liveness is decided the way the overview decides it — a session's PTY is a
 * child of this app, so no live terminal means the process is gone whatever its
 * last recorded state says — using the registry's own helpers, so the bar can
 * never claim a running agent the panel it points at doesn't list.
 */
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import type { SessionState } from "../../../bindings";
import { bucketOf, parseTermKey, terminalRefFor } from "../../../features/agents/registry";
import { useAttentionCount } from "../../../features/agents/useAgents";
import type { TerminalTab } from "../../../features/terminal/orchestrator";
import { useTerminals } from "../../../features/terminal/TerminalsContext";
import { useSessionStates } from "../../../lib/queries";
import { sessionStateMeta } from "../../../theme/colors";
import { AgentsIcon } from "../../icons";
import { StatusButton } from "./StatusSegment";

/** Sessions with a live PTY in this app that haven't exited — the agents that
 *  are actually running right now, as opposed to rows the table still holds. */
function countLive(sessions: SessionState[], terminals: TerminalTab[]): number {
  let n = 0;
  for (const s of sessions) {
    const ref = terminalRefFor(s.termKey, parseTermKey(s.termKey), s.agentKind);
    const live = !!ref && terminals.some((t) => t.source === ref.source && t.refId === ref.refId);
    if (live && bucketOf(s.state, live) !== "done") n++;
  }
  return n;
}

/** The agents count, and the only entry point to the cross-repo overview. */
export function AgentsSegment() {
  const navigate = useNavigate();
  const { data: sessions } = useSessionStates();
  const { tabs } = useTerminals();
  const needsYou = useAttentionCount();
  const running = useMemo(() => (sessions ? countLive(sessions, tabs) : null), [sessions, tabs]);

  const label = running === null ? "Agents" : `${running} agents, ${needsYou} needing you`;
  return (
    <StatusButton
      onClick={() => navigate({ to: "/" })}
      title="Every agent, across repos"
      aria-label={label}
    >
      <AgentsIcon size={11} />
      <span className="tabular-nums">{running === null ? "—" : running} agents</span>
      <span className="text-muted-5">·</span>
      <span
        className="tabular-nums"
        style={needsYou > 0 ? { color: sessionStateMeta.waiting.color } : undefined}
      >
        {needsYou} needs you
      </span>
    </StatusButton>
  );
}
