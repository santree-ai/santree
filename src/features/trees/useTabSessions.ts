/** A worktree tab and its process, kept in step in both directions.
 *
 *  A tab row (`worktree_tabs`) and a PTY session are different things — one names
 *  what the strip draws, the other what is running — and a tab can briefly have
 *  either without the other. Two rules join them, and both strips that render
 *  worktree tabs (Trees' {@link MainTabBar}, Reviews' {@link ReviewTabBar}) need
 *  the same ones, so they live here rather than in either bar. */
import { useEffect, useRef } from "react";

import type { WorktreeTab } from "../../bindings";
import { useTerminals } from "../terminal/TerminalsContext";

/** The terminal-registry name a worktree tab's session is keyed by. */
export function tabRefId(worktreeId: string, tabId: string): string {
  return `tree:${worktreeId}:tab:${tabId}`;
}

export function useTabSessions(
  worktreeId: string,
  tabs: WorktreeTab[],
  closeTab: (id: string) => void,
): { closeWithSession: (tab: WorktreeTab) => void } {
  // The live PTY registry, not the tab rows — see the file comment.
  const { tabs: sessions, close: endSession } = useTerminals();

  // A tab is its process. Once that process exits its session vanishes from the
  // registry, and the tab goes with it rather than lingering as a dead one to ✕ by
  // hand — for an agent exactly as for a shell, because a pane with nothing
  // running in it has nothing to show and Session history already keeps the
  // conversation. We only prune a tab we've *seen* live, so the gap before a
  // freshly-opened session registers doesn't drop it, and a tab restored by a
  // restart waits to be opened rather than being swept before it ever runs.
  const seen = useRef<{ worktreeId: string; ids: Set<string> }>({
    worktreeId,
    ids: new Set(),
  });
  useEffect(() => {
    // Another worktree's tabs are another worktree's processes: carrying the
    // sightings across would prune a tab of the new one that has never run.
    if (seen.current.worktreeId !== worktreeId) seen.current = { worktreeId, ids: new Set() };
    const { ids } = seen.current;
    for (const t of tabs) {
      const alive = sessions.some((x) => x.refId === tabRefId(worktreeId, t.id));
      if (alive) ids.add(t.id);
      else if (ids.has(t.id)) {
        ids.delete(t.id);
        closeTab(t.id);
      }
    }
  }, [sessions, tabs, worktreeId, closeTab]);

  // Closing a tab tears its PTY session down (found by refId) too, so it doesn't
  // linger in the global Terminal tab, and the row goes with it — an agent tab's
  // stored session is forgotten by the backend. The conversation itself survives
  // on disk: Session history is how it comes back.
  const closeWithSession = (t: WorktreeTab) => {
    const live = sessions.find((x) => x.refId === tabRefId(worktreeId, t.id));
    if (live) endSession(live.key);
    closeTab(t.id);
  };

  return { closeWithSession };
}
