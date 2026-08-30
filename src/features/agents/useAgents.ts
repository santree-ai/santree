/** Data hooks for the agent registry. Every consumer is cross-repo — the sidebar
 *  tree, the Tickets fold, a worktree's session history — so these read a caller-
 *  supplied repo list rather than the app's single active one. */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { AgentKind } from "../../bindings";
import {
  queryKeys,
  useAgentProcesses,
  useBaseWorktreesByRepo,
  useSessionStates,
  useTasksByRepo,
  useWorktreesByRepo,
} from "../../lib/queries";
import { useLiveNow } from "../../lib/relativeTime";
import type { TerminalTab } from "../terminal/orchestrator";
import { paneAddress } from "../terminal/paneAddress";
import { useSessionTitles } from "../terminal/sessionTitles";
import { useTerminals } from "../terminal/TerminalsContext";
import { type AgentEntry, buildAgentEntries, countAttention, type RepoData } from "./registry";

/**
 * Every live agent across the shown repos, folded into display entries.
 *
 * `undefined` while the session read is still in flight — the panel shows a
 * skeleton for that, never an empty state: "no agents yet" and "we haven't
 * looked yet" are different answers and the user reads this one as fact.
 */
export function useAgentEntries(
  shownRepos: string[],
  allRepos: string[],
): AgentEntry[] | undefined {
  const { data: sessions } = useSessionStates();
  const { tabs: terminals } = useTerminals();
  // Only moves when a title's *meaning* does, not once per spinner frame — see
  // `sessionTitles`.
  const titles = useSessionTitles();
  const detected = useDetectedAgents(terminals);
  const worktrees = useWorktreesByRepo(shownRepos);
  const tasks = useTasksByRepo(shownRepos);
  const bases = useBaseWorktreesByRepo(shownRepos);
  // The shared 30s clock, so the "recently finished" window closes on its own
  // instead of at the next unrelated re-render.
  const nowMs = useLiveNow();

  const repos = useMemo<RepoData[]>(
    () =>
      shownRepos.map((repo) => ({
        repo,
        worktrees: worktrees.get(repo) ?? [],
        tasks: tasks.get(repo) ?? [],
        baseWorktree: bases.get(repo) ?? null,
      })),
    [shownRepos, worktrees, tasks, bases],
  );

  return useMemo(() => {
    if (!sessions) return undefined;
    return buildAgentEntries({ sessions, terminals, repos, allRepos, titles, detected, nowMs });
  }, [sessions, terminals, repos, allRepos, titles, detected, nowMs]);
}

/**
 * Which agent the process table sees in each open pane, by the pane's address —
 * its `term_key` and the provider santree launched in it — santree's own answer
 * to "which CLI is actually running here", independent of what it launched or
 * what a hook said (see `agent_procs.rs`). Keyed by the pair because a surface
 * can hold a pane per provider, and the scan answers per pane.
 *
 * The scan is bound to the panes rather than to a clock: opening or closing one
 * invalidates the read immediately, which is what makes a freshly opened Codex
 * tab recognised without waiting for an interval (or for the user to type). The
 * query's own cadence then only has to catch an agent started *inside* an
 * existing pane. Orca triggers the same scan on pane bind and on the shell's
 * OSC 133 command start/finish; santree has no shell integration to hook, so
 * the tab set is the bind signal it does have.
 *
 * Exported because the status bar's live count needs the same tier-2 signal the
 * fold does — it is one of the arbiter's three inputs (`lib/paneAgentOwner.ts`),
 * and a consumer that skipped it would be back to counting santree's launch
 * record alone. Two mounted callers cost one query and one `ps`: they share the
 * cache key, and the two invalidations land in the same tick, where the second
 * rides the first's in-flight fetch.
 */
export function useDetectedAgents(terminals: TerminalTab[]): ReadonlyMap<string, AgentKind> {
  const qc = useQueryClient();
  // The pane keys, as one string, so the effect fires when the *set* changes and
  // not on every re-render that hands back a new array.
  const panes = terminals.map((t) => paneAddress(t.refId ?? t.key, t.agent?.kind)).join("\u001f");
  useEffect(() => {
    // Nothing open is nothing to scan, and the query is idle in that state
    // anyway — so the last pane closing costs no `ps`.
    if (!panes) return;
    qc.invalidateQueries({ queryKey: queryKeys.agentProcesses });
  }, [qc, panes]);

  const { data } = useAgentProcesses(terminals.length);
  return useMemo(
    () => new Map((data ?? []).map((p) => [paneAddress(p.termKey, p.paneAgentKind), p.agentKind])),
    [data],
  );
}

/**
 * How many agents are blocked on the user — the number the nav badge shows.
 *
 * Skips the per-repo enrichment {@link useAgentEntries} does (this runs in the
 * always-mounted nav chrome) but shares its bucketing, so the badge can't claim
 * an alert the panel doesn't show. In particular it needs the live terminals:
 * a session with no PTY isn't waiting on anyone, whatever its last hook wrote.
 *
 * Deliberately *not* filtered by the shown-repos setting: hiding a repo from the
 * list shouldn't hide the fact that something over there needs you.
 */
export function useAttentionCount(): number {
  const { data: sessions } = useSessionStates();
  const { tabs: terminals } = useTerminals();
  // The count has to settle on its own: the failure this guards against is a
  // session whose row STOPS changing, so nothing in the data will ever re-run
  // this. The shared 30s clock does, which is a fine resolution for a badge
  // whose freshness window is half an hour.
  const nowMs = useLiveNow();
  return useMemo(
    () => countAttention(sessions ?? [], terminals, nowMs),
    [sessions, terminals, nowMs],
  );
}
