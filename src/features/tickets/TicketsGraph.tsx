/**
 * Graph mode: the existing dependency graph, embedded unchanged.
 *
 * The graph is repo-scoped by construction — dagre lays out one repo's blocker
 * edges into project bands — so it stays on the active repo while the list it
 * alternates with spans every repo. Nothing here reimplements it: the canvas is
 * the Issues one, reading the `IssuesProvider` the page mounts around both
 * modes (so the focused ticket and the inspector beside it are shared). The
 * launch tray floats over the canvas for the same reason: it belonged to a rail
 * this page no longer has, and losing it would mean losing multi-ticket
 * launching with it.
 */
import { useMemo } from "react";

import { Button, Dot } from "../../components/primitives";
import { accentActiveStyle, successColor } from "../../theme/colors";
import { GraphCanvas } from "../issues/GraphCanvas";
import { LaunchPanel } from "../issues/LaunchPanel";
import { useIssues } from "../issues/model";

/** The queue's two controls — fill it with everything ready, then launch it. */
function LaunchTray() {
  const { tasks, isEligible, selected, selectReady } = useIssues();

  const readyIds = useMemo(
    () => tasks.filter((t) => t.ready && isEligible(t)).map((t) => t.id),
    [tasks, isEligible],
  );
  const allReadySelected = readyIds.length > 0 && readyIds.every((id) => selected[id]);

  return (
    <div className="absolute top-3 right-3 z-10 w-60 overflow-hidden rounded-xl border border-line-2 bg-panel shadow-2xl">
      <div className="p-2">
        <Button
          size="sm"
          onClick={selectReady}
          disabled={readyIds.length === 0}
          title="Add all ready tickets to the launch selection"
          className="w-full"
          style={allReadySelected ? accentActiveStyle() : undefined}
        >
          <Dot color={successColor} size={6} />
          Select Ready {readyIds.length}
        </Button>
      </div>
      <LaunchPanel />
    </div>
  );
}

export function TicketsGraph() {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app">
      <GraphCanvas />
      <LaunchTray />
    </div>
  );
}
