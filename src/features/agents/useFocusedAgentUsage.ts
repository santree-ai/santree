/**
 * The live usage of the agent session the user is currently looking at.
 *
 * Two joins, and every link is allowed to be missing: the focused tab → its
 * session (matched on `termKey`, the logical terminal that owns it — *not* on
 * `cwd`, which a worktree's several tabs all share), then that session → the
 * last row its status line reported. `null` at any break, because the honest
 * answer to "how full is this agent's context" is often "we don't know yet":
 * the session may never have rendered a status line, or belong to a provider
 * santree captures no usage for. Only Claude reports one today, so a focused
 * Codex tab renders nothing rather than someone else's numbers — and lights up
 * for free the day a Codex source lands.
 */
import type { SessionUsageLive } from "../../bindings";
import { useSessionStates, useSessionUsageLive } from "../../lib/queries";
import type { FocusedAgent } from "../../state/AppContext";

export function useFocusedAgentUsage(focused: FocusedAgent | null): SessionUsageLive | null {
  const { data: sessions } = useSessionStates();
  const { data: live } = useSessionUsageLive();
  if (!focused) return null;
  const session = sessions?.find((s) => s.repo === focused.repo && s.termKey === focused.termKey);
  if (!session) return null;
  return live?.find((u) => u.sessionId === session.sessionId) ?? null;
}
