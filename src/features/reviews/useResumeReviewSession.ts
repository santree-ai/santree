/**
 * "Run this conversation again", for the Reviews strip.
 *
 * The mirror of Trees' {@link useResumeSessionInWorktree}, and it exists for the
 * same reason that one lives beside `SessionHistory` rather than inside it: a
 * resume produces a **tab**, and only a host with a strip can hold one. Reviews
 * had no strip when that was written; it does now, so a review's conversation is
 * reachable again after its tab is closed.
 *
 * That round trip is what makes closing an AI review safe. The ✕ forgets the
 * stored session so the tab doesn't reappear on the next launch, but the
 * transcript stays on disk — and this is the way back to it: a resumed session
 * opens as an ordinary agent tab in the PR's checkout, bound to the id that was
 * clicked.
 */
import { useCallback, useState } from "react";

import type { WorktreeSession } from "../../bindings";
import { useResumeWorktreeSession } from "../../lib/queries";
import type { SessionResumer } from "../trees/useResumeSession";
import type { ReviewTabs } from "./useReviewTabs";

export function useResumeReviewSession(tabs: ReviewTabs): SessionResumer {
  const { repo, worktreeId } = tabs.checkout;
  const resumeSession = useResumeWorktreeSession(repo, worktreeId);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const resume = useCallback(
    (session: WorktreeSession) => {
      if (resumingId || !worktreeId) return;
      const tabId = crypto.randomUUID();
      setResumingId(session.sessionId);
      void (async () => {
        try {
          // The session row must be committed before the tab's pane mounts, or
          // the pane resolves a launch with nothing to resume and starts a
          // *fresh* conversation instead of the one that was clicked. Same
          // ordering Trees relies on; the tab is minted second, and by the same
          // `addTab` every other tab on this strip goes through.
          await resumeSession.mutateAsync({
            tabId,
            sessionId: session.sessionId,
            agentKind: session.agentKind,
          });
          tabs.addTab("agent", session.agentKind, tabId);
        } catch {
          // A failed mutation already red-toasts globally (main.tsx); the tab is
          // simply not opened.
        } finally {
          setResumingId(null);
        }
      })();
    },
    [resumingId, worktreeId, resumeSession, tabs],
  );

  return { resume, resumingId };
}
