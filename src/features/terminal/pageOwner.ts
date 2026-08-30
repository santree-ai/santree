/**
 * This page load's identity, as far as the PTY manager is concerned.
 *
 * A terminal session is owned by the *document*, not by the component that
 * opened it: that is what lets it keep running while you look at another view.
 * Every handle to one — the tab list, the byte channel, the xterm that renders
 * it — lives in this page, and a reload throws all of it away.
 *
 * That used to mean the sessions had to die too: nothing on the new page could
 * reach them, so a reload stranded a shell and everything it had spawned, and
 * the tag was how the next page found them to kill them.
 *
 * It no longer does. Each session records its own recent output, so a reloaded
 * page can rebuild the tab from the session's label and catch the pane up from
 * the stream. The tag now marks a hand-over instead of a kill list
 * (`terminal_adopt`), and a reload costs the view rather than the work.
 *
 * Module scope, not state: it has to be minted exactly once per document and be
 * the same value for every `open` on it, including the ones that happen before
 * React has mounted anything.
 */
export const PAGE_OWNER = crypto.randomUUID();
