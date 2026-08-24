/**
 * The live/ended bookkeeping both Reviews sessions need.
 *
 * A terminal pane can't just ask "is there a session?" and act on it. Quitting the
 * agent has to leave the pane showing a resume offer rather than immediately
 * relaunching, and a resume has to be a deliberate act — so "there is a live PTY"
 * and "there was one while this pane was mounted" are different facts, and the
 * second one latches.
 */
import { useEffect, useState } from "react";

import { useTerminals } from "../terminal/TerminalsContext";

export interface ReviewSessionLatch {
  /** A PTY for this key is running right now. */
  liveSession: boolean;
  /** The session ended while this pane watched, and the user hasn't asked to pick
   *  it back up: show the resume pane instead of the terminal. */
  ended: boolean;
  /** Nothing to attach to, so this open is a launch — resolve a seed. */
  needsSeed: boolean;
  /** Whether a resume is what's being resolved (a launch after an explicit ask). */
  resumeRequested: boolean;
  requestResume: () => void;
}

export function useReviewSessionLatch(termKey: string): ReviewSessionLatch {
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "review" && t.refId === termKey);
  // State, not a ref, so the exit re-renders the pane into its resume offer.
  const [liveSeen, setLiveSeen] = useState(false);
  const [resumeRequested, setResumeRequested] = useState(false);

  useEffect(() => {
    if (liveSession) {
      setLiveSeen(true);
      setResumeRequested(false);
    }
  }, [liveSession]);

  return {
    liveSession,
    ended: !liveSession && liveSeen && !resumeRequested,
    needsSeed: !liveSession && !liveSeen,
    resumeRequested,
    requestResume: () => {
      setResumeRequested(true);
      setLiveSeen(false);
    },
  };
}
