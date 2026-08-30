/**
 * How many agents are running, and how many of them are blocked on you.
 *
 * A readout, not a door: the sidebar's project tree lists every one of these
 * rows, so a click here would only lead somewhere already on screen. Always
 * rendered — including while the session read is in flight, where it shows a
 * dash rather than the "0 agents" that would read as an answer. The count of
 * agents needing you is the one number in the bar that earns a color: it is the
 * only thing here that goes stale by being ignored.
 *
 * Liveness is decided the way the tree decides it — a session's PTY is a child of
 * this app, so no live terminal means the process is gone whatever its last
 * recorded state says — through the registry's own helpers, so the bar can never
 * claim a running agent the tree doesn't list.
 */
import { useMemo } from "react";

import type { SessionState } from "../../../bindings";
import { bucketOf, parseTermKey, terminalRefFor } from "../../../features/agents/registry";
import { useAttentionCount } from "../../../features/agents/useAgents";
import type { TerminalTab } from "../../../features/terminal/orchestrator";
import { useTerminals } from "../../../features/terminal/TerminalsContext";
import { useSessionStates } from "../../../lib/queries";
import { sessionStateMeta } from "../../../theme/colors";
import { AgentsIcon } from "../../icons";
import { STATUS_SEGMENT } from "./StatusSegment";

/** Sessions with a live PTY in this app that haven't exited — the agents that
 *  are actually running right now, as opposed to rows the table still holds —
 *  plus the ones santree has launched that no row speaks for yet.
 *
 *  That second group is not a rounding error: Codex fires `SessionStart` on its
 *  first submitted turn, so a tab opened and left at the prompt has a running
 *  agent and no row (see `registry.ts`). The tree counts it; so must this. */
function countLive(sessions: SessionState[], terminals: TerminalTab[]): number {
  const announced = new Set<string>();
  let n = 0;
  for (const s of sessions) {
    const ref = terminalRefFor(s.termKey, parseTermKey(s.termKey), s.agentKind);
    const tab = ref && terminals.find((t) => t.source === ref.source && t.refId === ref.refId);
    if (!tab) continue;
    announced.add(tab.key);
    if (bucketOf(s.state, true) !== "done") n++;
  }
  for (const t of terminals) if (t.agent && !announced.has(t.key)) n++;
  return n;
}

/** The cross-repo agent count. */
export function AgentsSegment() {
  const { data: sessions } = useSessionStates();
  const { tabs } = useTerminals();
  const needsYou = useAttentionCount();
  const running = useMemo(() => (sessions ? countLive(sessions, tabs) : null), [sessions, tabs]);

  // No `aria-label`: the two counts below are already the reading, and a plain
  // span can't carry one anyway.
  return (
    <span className={`${STATUS_SEGMENT} text-muted-4`} title="Every agent, across repos">
      <AgentsIcon size={11} />
      <span className="tabular-nums">
        {running === null ? "—" : running} {running === 1 ? "agent" : "agents"}
      </span>
      <span className="text-muted-5">·</span>
      <span
        className="tabular-nums"
        style={needsYou > 0 ? { color: sessionStateMeta.waiting.color } : undefined}
      >
        {needsYou} needs you
      </span>
    </span>
  );
}
