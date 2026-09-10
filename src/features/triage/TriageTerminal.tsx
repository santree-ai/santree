/**
 * A pane on a triage ticket's surface: one of the ticket's own tabs — a login
 * shell on the attached project's main checkout, or the agent session a row
 * launches (`TriageTabPane` hands the seed and identity in) — embedded the way
 * an investigation is. The Terminal tab groups it with them under Triage, and
 * the sidebar files anything the process table later spots inside it (a
 * `claude` typed by hand) under this ticket, by way of `parseTermKey` reading
 * the `triage:<id>` off the pane's refId.
 *
 * `refId` is the row's own key (`triage:<ticket>:tab:<id>`, from `tabRefId`),
 * never the bare surface key: the orchestrator keys a pane by (source, refId,
 * provider), and the investigations already hold the bare key, one per
 * provider — a shell on it would be the pane every provider-less lookup found.
 *
 * `WorktreeTerminal` is not reused: it hardcodes `source: "issue"` and a `tree:`
 * key, and the surface is the whole of what this file says.
 *
 * Mounted only while its tab shows. The PTY lives in the global terminal layer,
 * so unmounting detaches and never closes; the tab's ✕ is what ends it.
 */
import type { AgentTabIdentity } from "../terminal/orchestrator";
import { useEmbeddedTerminal } from "../terminal/useEmbeddedTerminal";

export function TriageTerminal({
  refId,
  title,
  cwd,
  seed,
  agent,
  onExited,
}: {
  /** The row's term key — see the file comment. */
  refId: string;
  /** The tab's title, which is the PTY's. */
  title: string;
  /** The attached project's root — the main checkout, never a worktree. */
  cwd: string;
  /** The agent's launch line, or undefined for a plain shell. */
  seed?: string;
  /** Who this pane runs, when it runs an agent — see {@link AgentTabIdentity}. */
  agent?: AgentTabIdentity;
  /** Fired once when the process exits. */
  onExited?: () => void;
}) {
  const { hostRef } = useEmbeddedTerminal({
    spec: { title, cwd, source: "triage", refId, seed, agent },
    onExited,
  });
  // The TerminalLayer overlays this host with the ticket's live pane.
  return <div ref={hostRef} className="h-full w-full" />;
}
