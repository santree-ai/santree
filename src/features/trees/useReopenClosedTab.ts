/**
 * "Take me to this agent", for an agent whose tab is gone.
 *
 * A tab is its process: once that process exits the row is deleted
 * (`useTabSessions`), because a pane with nothing running in it has nothing to
 * show. The *session* outlives it — the sidebar still lists the agent, in the
 * `done`/`detached` buckets — so clicking one asked to be taken to a tab that no
 * longer exists, the focus fell back to whatever else was open, and the click
 * read as broken: the agent is right there in the rail and nothing happens.
 *
 * What "open" has always meant for a session with no live PTY is stated in the
 * registry itself: *opening resumes the conversation*. So that is what this
 * does, through the one resume path Trees already has — the same tab Session
 * history would have produced, reached by clicking the agent instead of hunting
 * for its row.
 *
 * It waits for the sessions read rather than acting on `data ?? []`: an empty
 * list mid-fetch is "we haven't looked", and resuming nothing on that basis
 * would silently drop the request the user just made.
 */
import { useEffect } from "react";

import { useWorktreeSessions } from "../../lib/queries";
import { useTrees } from "./model";
import { useResumeSessionInWorktree } from "./useResumeSession";
import { tabRefId } from "./useTabSessions";

export function useReopenClosedTab(): void {
  const { repo, activeId, reopenTab, consumeReopenTab } = useTrees();
  // Only once the worktree the request named is the active one: the resumer
  // below mints its tab in whatever worktree Trees is showing, so acting a
  // render early would put the conversation in the wrong tree.
  const pending = reopenTab?.worktreeId === activeId ? reopenTab : null;
  const { data: sessions } = useWorktreeSessions(repo, pending ? activeId : "");
  const { resume, resumingId } = useResumeSessionInWorktree();

  useEffect(() => {
    if (!pending || resumingId || sessions === undefined) return;
    const session = sessions.find((s) => s.termKey === tabRefId(pending.worktreeId, pending.tabId));
    // Consumed either way. A tab with no session behind it is one santree has no
    // conversation for, and leaving the request pending would re-fire it on
    // every refetch.
    consumeReopenTab();
    if (session) resume(session);
  }, [pending, sessions, resumingId, resume, consumeReopenTab]);
}
