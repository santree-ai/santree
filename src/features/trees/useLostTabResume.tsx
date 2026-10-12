/** Resume, in place, an agent tab whose pane's session is lost — every surface
 *  whose agents are `worktree_tabs` rows: a worktree's tabs, a review checkout's
 *  (the same pane) and a triage ticket's own.
 *
 *  The layer holds the row through the gap (`holdRow`, before the lost pane
 *  closes), so the conversation keeps its binding: closing the row would delete
 *  it, and nothing could then say which conversation the tab held. On the one
 *  click, the backend confirms nothing can still be running the session
 *  (`check_tab_resume`: a complete answer, no live pane on the key) and the tab
 *  relaunches on it; a refusal, or a relaunch that throws, lets the row go the
 *  way a closed pane's does. */
import { useCallback, useState } from "react";

import { EmptyState } from "../../components/primitives";
import { useCheckTabResume } from "../../lib/queries";
import { toast } from "../../state/toast";
import { useTerminals } from "../terminal/TerminalsContext";

export function useLostTabResume({
  repo,
  owner,
  tabId,
  refId,
  ended,
  resume,
}: {
  /** The project the row and its session are stored under. */
  repo: string;
  /** The row's owner: a worktree id, or a triage ticket's `triage:<ticket>`. */
  owner: string;
  tabId: string;
  /** The tab's terminal key (`tabRefId(owner, tabId)`). */
  refId: string;
  /** `useAgentTab`'s: the pane it saw is gone. */
  ended: boolean;
  /** `useAgentTab`'s relaunch. */
  resume: () => void | Promise<void>;
}): {
  /** The pane's Resume, for its embed. */
  onResume: () => void;
  /** From the lost pane closing until the relaunch, or until a refused row is
   *  gone: the tab must not mount a terminal, or the old seed would open a pane
   *  on its own — after a refusal, beside the session still running. */
  resuming: boolean;
} {
  const { heldRows, releaseRow } = useTerminals();
  const { mutateAsync: checkResume } = useCheckTabResume(repo);
  const [refused, setRefused] = useState(false);
  // A promise rather than `mutate`'s callbacks, which are dropped if the tab is
  // switched away mid-check: a refusal must still let the row go.
  const onResume = useCallback(() => {
    const letGo = () => {
      setRefused(true);
      releaseRow(refId);
    };
    checkResume({ owner, tabId }).then(async () => {
      try {
        await resume();
      } catch (e) {
        // The check's own failure is toasted by the mutation policy; this one
        // happens outside any query, so it says so itself.
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`resume failed ${refId}: ${message}`);
        toast.error(message);
        letGo();
      }
    }, letGo);
  }, [checkResume, owner, tabId, resume, releaseRow, refId]);
  return { onResume, resuming: ended && (refused || heldRows.has(refId)) };
}

export function ResumingState() {
  return (
    <EmptyState className="h-full" title="Resuming…" subtitle="Checking the session is free." />
  );
}
