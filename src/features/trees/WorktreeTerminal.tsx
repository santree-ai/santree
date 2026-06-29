/**
 * A worktree's live terminal — a real PTY rooted in the worktree directory,
 * embedded via the persistent TerminalLayer (same mechanism as the triage
 * Investigate pane). The session is keyed by `tree:<id>` so it persists across
 * view switches and also appears in the Terminal tab.
 *
 * When `seed` is set (a task was just started) it launches the agent on first
 * open; otherwise it's a plain login shell. The seed only takes effect when the
 * session is first created — re-opening reuses the existing session — so we
 * clear the one-shot launch flag once mounted.
 */
import { useEffect, useRef } from "react";

import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function WorktreeTerminal({
  id,
  branch,
  cwd,
  seed,
  onLaunched,
}: {
  id: string;
  branch: string;
  cwd: string;
  /** Command to launch the agent (e.g. `exec claude '…'`), or undefined for a shell. */
  seed?: string;
  /** Fired once after mount when a seed was provided, to clear the launch flag. */
  onLaunched?: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: branch, cwd, source: "issue", refId: `tree:${id}`, seed },
  });

  const consumed = useRef(false);
  useEffect(() => {
    if (seed && !consumed.current) {
      consumed.current = true;
      onLaunched?.();
    }
  }, [seed, onLaunched]);

  // The TerminalLayer overlays this host with the worktree's live session. This
  // component is mounted only while the Terminal tab is active; the session itself
  // persists in the layer, so detaching here never kills or resizes the shell.
  return <div ref={hostRef} className="h-full w-full" />;
}
