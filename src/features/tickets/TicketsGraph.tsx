/**
 * Graph mode: the existing dependency graph, embedded unchanged.
 *
 * The graph is repo-scoped by construction — dagre lays out one repo's blocker
 * edges into project bands — so it stays on the active repo while the list it
 * alternates with spans every repo. Nothing here reimplements it: the canvas is
 * the Issues one, reading the `IssuesProvider` the page mounts around both
 * modes (so the focused ticket and the inspector beside it are shared). The
 * page's own strip carries the filter and the queue's Select Ready, and the
 * rail carries the queue and its launch — none of it is a graph thing, so
 * nothing floats over the canvas any more.
 */
import { GraphCanvas } from "../issues/GraphCanvas";

export function TicketsGraph() {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app">
      <GraphCanvas />
    </div>
  );
}
