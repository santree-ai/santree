/**
 * Tickets — every ticket in the house, on one page.
 *
 * The tab this replaces was repo-scoped: a rail of the active repo's queue next
 * to its dependency graph. But "what should I pick up next" is never a
 * single-repo question, and the answer was split across as many tabs as there
 * were repos. List mode collapses that into one scroll across every registered
 * repo; Graph mode keeps the dependency view for the one question that *is*
 * repo-shaped — what unblocks what.
 *
 * The two modes are two renderings of the same selection. One `IssuesProvider`
 * is mounted for the page, so the focused ticket, the inspector on the right and
 * the launch queue all survive a mode switch — clicking a ticket in either mode
 * opens it in the inspector, and the segmented control only changes how the
 * tickets are laid out. The page also owns the "Actionable only" filter, which
 * both modes and their chords share.
 */
import { useCallback, useMemo } from "react";

import { BranchIcon, ListIcon } from "../../components/icons";
import { Button, Dot, Segmented, SwitchTrack } from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { usePersistedState } from "../../lib/usePersistedState";
import { CHROME } from "../../state/AppContext";
import { raisedActiveStyle, successColor } from "../../theme/colors";
import { IssuesProvider, useIssues } from "../issues/model";
import { RightPanel } from "../issues/RightPanel";
import { useIssuesShortcuts } from "../issues/shortcuts";
import { TicketsGraph } from "./TicketsGraph";
import { TicketsList } from "./TicketsList";
import { type TicketProjectGroup, type TicketsSummary, useTickets } from "./useTickets";

type Mode = "list" | "graph";

const MODE_KEY = "santree.tickets.mode";
const ACTIONABLE_KEY = "santree.tickets.actionableOnly";

const MODE_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon size={11} /> },
  { value: "graph" as const, label: "Graph", icon: <BranchIcon size={11} /> },
];

/** "128 across 6 projects · 14 ready · 9 blocked" — the page in one line. */
function summaryLine({ total, projects, ready, blocked }: TicketsSummary): string {
  const scope = `${total} across ${projects} project${projects === 1 ? "" : "s"}`;
  return `${scope} · ${ready} ready · ${blocked} blocked`;
}

/** The filter, as the switch it is — drawn as one chip of the same family as
 *  the button and the segmented control beside it: the same height, edge and
 *  fill, with a small track inside next to the words. A full-size settings
 *  switch standing free beside a label was the one heavy, unbordered thing in
 *  the row, and read as a stranger to it. The whole chip is the switch. */
function ActionableSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={
        on
          ? "Showing only tickets you can act on (⌘⇧.). Turn off to reveal blockers owned by others or already done."
          : "Showing all related tickets (⌘⇧.). Turn on to hide the non-actionable ones."
      }
      className={`flex h-6 flex-none cursor-pointer items-center gap-2 rounded-md border border-line-2 bg-input pr-1.5 pl-2.5 text-[11px] whitespace-nowrap transition-colors hover:border-line-strong ${
        on ? "text-fg-2" : "text-muted-2"
      }`}
    >
      Actionable only
      <SwitchTrack on={on} size="sm" />
    </button>
  );
}

/** Fill the launch queue with every ready ticket — or, raised, empty it of them
 *  again. It was the graph's floating tray's; the queue is not a graph thing,
 *  so it sits with the page's other controls and works over the list too. The
 *  count is the active repo's, which is the repo a launch runs in. The model
 *  opens the rail on the queue pane when this fills it. */
function SelectReadyButton() {
  const { tasks, isEligible, selected, selectReady } = useIssues();
  const readyIds = useMemo(
    () => tasks.filter((t) => t.ready && isEligible(t)).map((t) => t.id),
    [tasks, isEligible],
  );
  const allSelected = readyIds.length > 0 && readyIds.every((id) => selected[id]);

  return (
    <Button
      size="sm"
      onClick={selectReady}
      disabled={readyIds.length === 0}
      aria-pressed={allSelected}
      title={
        allSelected
          ? "Take the ready tickets back out of the launch queue"
          : "Add every ready ticket to the launch queue"
      }
      className="h-6 flex-none px-2 whitespace-nowrap"
      style={allSelected ? raisedActiveStyle() : undefined}
    >
      <Dot color={successColor} size={5} />
      Select Ready
      <span className="font-mono text-[10px] tabular-nums opacity-70">{readyIds.length}</span>
    </Button>
  );
}

/** The page's chords — ⌘⇧. for the filter, ⌘L for the inspector — bound once,
 *  inside the provider, so they work the same in both modes. */
function TicketsShortcuts({ onToggleActionable }: { onToggleActionable: () => void }) {
  const { toggleRightPanel } = useIssues();
  useIssuesShortcuts({ onToggleActionable, onToggleRightPanel: toggleRightPanel });
  return null;
}

export function TicketsView() {
  const [mode, setMode] = usePersistedState<Mode>(MODE_KEY, "list");
  const [actionableOnly, setActionableOnly] = usePersistedState(ACTIONABLE_KEY, true);
  const { groups, summary, loading } = useTickets(actionableOnly);

  const toggleActionable = useCallback(() => setActionableOnly((v) => !v), [setActionableOnly]);

  // Handed to the graph's model, which reads and writes the same filter from its
  // own in-canvas toggle — one state, two controls.
  const actionable = useMemo(
    () => ({ value: actionableOnly, set: setActionableOnly }),
    [actionableOnly, setActionableOnly],
  );

  return (
    <IssuesProvider actionable={actionable}>
      <TicketsShortcuts onToggleActionable={toggleActionable} />
      <TicketsPage
        mode={mode}
        onMode={setMode}
        actionableOnly={actionableOnly}
        onToggleActionable={toggleActionable}
        groups={groups}
        summary={summary}
        loading={loading}
      />
    </IssuesProvider>
  );
}

/** The page under the provider: its own strip over the list or graph, and the
 *  ticket rail beside both, full height — the shape Trees and Reviews have. */
function TicketsPage({
  mode,
  onMode,
  actionableOnly,
  onToggleActionable,
  groups,
  summary,
  loading,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  actionableOnly: boolean;
  onToggleActionable: () => void;
  groups: TicketProjectGroup[];
  summary: TicketsSummary;
  loading: boolean;
}) {
  const { rightCollapsed, toggleRightPanel } = useIssues();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-app">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The page's strip: the height and chrome of the other views' tab bars,
            so the rail's strip beside it reads as the same bar, and a drag
            region like theirs. Its trailing cluster ends 8px from the edge —
            where the rail's toggle sits while the rail is open — so when the
            rail collapses the toggle lands here without stepping sideways. */}
        <div
          data-tauri-drag-region
          className={`flex ${CHROME.subBar} flex-none items-center gap-2.5 border-b border-line bg-deep pr-2 pl-3`}
        >
          <span className="flex-none text-[13px] font-semibold text-fg">Tickets</span>
          <span className="min-w-0 truncate text-[11px] text-muted-4">{summaryLine(summary)}</span>
          <div className="ml-auto flex flex-none items-center gap-2">
            <SelectReadyButton />
            <ActionableSwitch on={actionableOnly} onToggle={onToggleActionable} />
            <Segmented
              options={MODE_OPTIONS}
              value={mode}
              onChange={onMode}
              className="w-[146px]"
            />
            {rightCollapsed && <PanelToggle collapsed onToggle={toggleRightPanel} />}
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          {mode === "list" ? <TicketsList groups={groups} loading={loading} /> : <TicketsGraph />}
        </div>
      </div>
      <RightPanel />
    </div>
  );
}
