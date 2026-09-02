/** "Run this conversation again": mint a tab, bind it to the session, open it.
 *
 *  Lives beside {@link SessionHistory} rather than inside it because only Trees
 *  can do it — what a resume produces is a tab in the worktree's main-area
 *  strip, and the Reviews rail hosting the same pane has no strip to put one in.
 *  The pane takes the click as a prop and stays host-agnostic; this is the whole
 *  of Trees' half. */
import { useCallback, useState } from "react";

import type { WorktreeSession } from "../../bindings";
import { useAddWorktreeTab, useResumeWorktreeSession } from "../../lib/queries";
import { defaultTabTitle, extraTab, useTrees } from "./model";

export interface SessionResumer {
  resume: (session: WorktreeSession) => void;
  /** The session currently being resumed, so its row can read busy. */
  resumingId: string | null;
}

export function useResumeSessionInWorktree(): SessionResumer {
  const { repo, activeId, tabs, setActiveTab } = useTrees();
  const addTab = useAddWorktreeTab(repo);
  const resumeSession = useResumeWorktreeSession(repo, activeId);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const resume = useCallback(
    (s: WorktreeSession) => {
      if (resumingId) return;
      const tabId = crypto.randomUUID();
      setResumingId(s.sessionId);
      void (async () => {
        try {
          // Both rows must be committed before the pane mounts: the backend
          // resolves a launch from the tab row and the session row in SQLite, and
          // a pane that beats them starts a *fresh* session instead of the one
          // that was clicked. The tab still appears at once — its mutation patches
          // the cache optimistically — only the focus waits.
          await resumeSession.mutateAsync({
            tabId,
            sessionId: s.sessionId,
            agentKind: s.agentKind,
          });
          await addTab.mutateAsync({
            id: tabId,
            worktreeId: activeId,
            kind: "agent",
            agentKind: s.agentKind,
            title: defaultTabTitle("agent", s.agentKind, tabs),
            // Only the review kinds carry a PR, and those arrive through their own
            // hand-off, never from here.
            pr: null,
          });
          setActiveTab(extraTab(tabId));
        } catch {
          // A failed mutation already red-toasts globally (main.tsx); the tab is
          // simply not opened.
        } finally {
          setResumingId(null);
        }
      })();
    },
    [activeId, addTab, tabs, resumeSession, resumingId, setActiveTab],
  );

  return { resume, resumingId };
}
