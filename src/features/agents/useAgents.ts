/** Data hooks for the Agents panel. The panel is cross-repo, so these read every
 *  *shown* repo rather than the app's single active one. */
import { useCallback, useMemo } from "react";

import {
  useBaseWorktreesByRepo,
  useRepos,
  useSessionStates,
  useTasksByRepo,
  useWorktreesByRepo,
} from "../../lib/queries";
import { useLiveNow } from "../../lib/relativeTime";
import { usePersistedState } from "../../lib/usePersistedState";
import { useTerminals } from "../terminal/TerminalsContext";
import { type AgentEntry, buildAgentEntries, countAttention, type RepoData } from "./registry";

/** Repos the user has hidden from the panel. Stored as the *exclusions* rather
 *  than the selection, so a newly registered repo shows up on its own — the
 *  default for a control panel is "everything I'm working on". */
const HIDDEN_REPOS_KEY = "santree.agents.hiddenRepos";

export interface RepoFilter {
  /** Every registered repo, in registration order. */
  all: string[];
  /** The repos currently rendered. */
  shown: string[];
  isShown: (repo: string) => boolean;
  toggle: (repo: string) => void;
  showAll: () => void;
  /** True when nothing is hidden — lets the trigger read "All repos". */
  allShown: boolean;
}

export function useRepoFilter(): RepoFilter {
  const { data: repos } = useRepos();
  const [hidden, setHidden] = usePersistedState<string[]>(HIDDEN_REPOS_KEY, []);

  const all = useMemo(() => (repos ?? []).map((r) => r.name), [repos]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  // Hiding every repo would leave a panel that can only ever be empty, with the
  // control that caused it collapsed into a dropdown. Treat "all hidden" as
  // "none hidden" instead of rendering a dead end.
  const effective = useMemo(() => {
    const kept = all.filter((r) => !hiddenSet.has(r));
    return kept.length > 0 ? kept : all;
  }, [all, hiddenSet]);

  const toggle = useCallback(
    (repo: string) =>
      setHidden((prev) => (prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo])),
    [setHidden],
  );

  return {
    all,
    shown: effective,
    isShown: (repo) => effective.includes(repo),
    toggle,
    showAll: useCallback(() => setHidden([]), [setHidden]),
    allShown: effective.length === all.length,
  };
}

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
    return buildAgentEntries({ sessions, terminals, repos, allRepos, nowMs });
  }, [sessions, terminals, repos, allRepos, nowMs]);
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
  return useMemo(() => countAttention(sessions ?? [], terminals), [sessions, terminals]);
}
