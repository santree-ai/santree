/**
 * A ticket's plain shell: a login shell on the attached project's main checkout,
 * embedded the way an investigation is — same surface key, so the Terminal tab
 * groups it with them under Triage, and the sidebar files anything the process
 * table later spots inside it (a `claude` typed by hand) under this ticket, by
 * way of `parseTermKey` reading the same `triage:<id>` off the pane's refId.
 *
 * No `agent`, on purpose: the orchestrator keys a pane by (source, refId,
 * provider), and every investigation lookup requires a provider — so the
 * provider being absent is exactly what keeps this pane from colliding with
 * theirs on the same refId.
 *
 * `WorktreeTerminal` is not reused: it hardcodes `source: "issue"` and a `tree:`
 * key, and the surface is the whole of what this file says.
 *
 * Mounted only while its tab shows. The PTY lives in the global terminal layer,
 * so unmounting detaches and never closes; the tab's ✕ is what ends it.
 */
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";
import { triageTermKey } from "./providerSessions";

export function TriageTerminal({
  ticketId,
  cwd,
  onExited,
}: {
  ticketId: string;
  /** The attached project's root — the main checkout, never a worktree. */
  cwd: string;
  /** Fired once when the shell exits; the host closes the tab. */
  onExited: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title: ticketId, cwd, source: "triage", refId: triageTermKey(ticketId) },
    onExited,
  });
  // The TerminalLayer overlays this host with the ticket's live shell.
  return <div ref={hostRef} className="h-full w-full" />;
}
