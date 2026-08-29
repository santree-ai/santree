/**
 * The agent you are *looking at*, as a status-bar segment: which model is
 * running, how full its context window is, and what the conversation has cost.
 *
 * This used to be a strip of its own above the worktree's bottom bar — two bars
 * stacked under the terminal, both of them chrome. It is ambient status about
 * something running elsewhere, which is exactly what this bar is for, and moving
 * it here gives the terminal the height back.
 *
 * The numbers are Claude's own: `session_usage_live` captures what its status
 * line reports over the signal socket, so the percentage here and the one inside
 * the terminal are the same figure (both apply the same 1.2x display nudge) —
 * unlike the earlier transcript-derived reconstruction, which drifted.
 *
 * **Scoped to the focused agent tab, and to nothing else.** It joined the open
 * *worktree* to its main terminal before, which is a claim the bar can't keep:
 * `openWorktree` deliberately survives a navigation, so the meter stayed up on
 * Triage, Reviews and Settings, and inside Trees it showed the main terminal's
 * numbers while the user was reading a diff or a second agent's tab. A context
 * fill belongs to one session, so it renders only while that session's tab is on
 * screen — see `focusedAgentFor` (Trees) and `useFocusedAgentUsage`. No focused
 * agent, no session for it, or no usage captured for it: nothing renders, rather
 * than someone else's numbers.
 */
import { useRouterState } from "@tanstack/react-router";

import { useFocusedAgentUsage } from "../../../features/agents/useFocusedAgentUsage";
import { displayFill, fillColor } from "../../../lib/contextFill";
import { formatUsd } from "../../../lib/format";
import { CLAUDE_STATUS_LINE_KEY, useBoolSetting } from "../../../lib/queries";
import { useAppUi } from "../../../state/AppContext";
import { modelVersion } from "../../../theme/colors";

export function SessionSegment() {
  const { focusedAgent } = useAppUi();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The Trees provider clears its focus on unmount, so this is a second gate,
  // not the only one — it closes the frame between a navigation committing and
  // that cleanup landing, where the bar would otherwise flash last workspace's
  // numbers over the new view.
  const onTrees = pathname.startsWith("/trees");
  const usage = useFocusedAgentUsage(onTrees ? focusedAgent : null);
  // Display-only gate (Settings → Agents). Capture runs regardless, so flipping
  // it shows or hides this instantly, with no relaunch.
  const shown = useBoolSetting("app", CLAUDE_STATUS_LINE_KEY).value;
  if (!shown || !usage) return null;

  const pct = displayFill(usage.usedPct);
  const color = fillColor(pct);
  const cost = usage.costUsd === null ? null : formatUsd(usage.costUsd);

  return (
    <span
      className="flex items-center gap-2 font-mono"
      title={`${modelVersion(usage.model)} · context ${pct}% full${
        cost ? ` · ${cost} this session` : ""
      }`}
    >
      <span className="text-muted-2">{modelVersion(usage.model)}</span>
      <span className="h-1.5 w-16 flex-none overflow-hidden rounded-full bg-input">
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="tabular-nums" style={{ color }}>
        {pct}%
      </span>
      {cost && <span className="tabular-nums">{cost}</span>}
    </span>
  );
}
