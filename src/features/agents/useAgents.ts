/** Data hooks for the agent registry. Every consumer is cross-repo — the sidebar
 *  tree, the Tickets fold, a worktree's session history — so these read a caller-
 *  supplied repo list rather than the app's single active one. */
import { useMemo } from "react";

import {
  useBaseWorktreesByRepo,
  useSessionStates,
  useTasksByRepo,
  useWorktreesByRepo,
} from "../../lib/queries";
import { useLiveNow } from "../../lib/relativeTime";
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
    return buildAgentEntries({ sessions, terminals, repos, allRepos, titles, nowMs });
  }, [sessions, terminals, repos, allRepos, titles, nowMs]);
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
