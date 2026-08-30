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
import { Dot, Segmented } from "../../components/primitives";
import { usePersistedState } from "../../lib/usePersistedState";
import { accentActiveStyle, successColor } from "../../theme/colors";
import { IssuesProvider, useIssues } from "../issues/model";
import { RightPanel } from "../issues/RightPanel";
import { useIssuesShortcuts } from "../issues/shortcuts";
import { TicketsGraph } from "./TicketsGraph";
import { TicketsList } from "./TicketsList";
import { type TicketsSummary, useTickets } from "./useTickets";

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

function ActionableChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={
        on
          ? "Showing only tickets you can act on (⌘⇧.). Click to reveal blockers owned by others or already done."
          : "Showing all related tickets (⌘⇧.). Click to hide the non-actionable ones."
      }
      className="flex h-6 flex-none cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 text-[11px] whitespace-nowrap text-muted-2 transition-colors hover:border-line-strong"
      style={on ? accentActiveStyle() : undefined}
    >
      <Dot color={on ? successColor : "var(--color-muted-4)"} size={5} />
      Actionable only
    </button>
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line px-3">
          <span className="flex-none text-[13px] font-semibold text-fg">Tickets</span>
          <span className="min-w-0 truncate text-[11px] text-muted-4">{summaryLine(summary)}</span>
          <div className="ml-auto flex flex-none items-center gap-2">
            <ActionableChip on={actionableOnly} onToggle={toggleActionable} />
            <Segmented
              options={MODE_OPTIONS}
              value={mode}
              onChange={setMode}
              className="w-[146px]"
            />
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          {mode === "list" ? <TicketsList groups={groups} loading={loading} /> : <TicketsGraph />}
          <RightPanel />
        </div>
      </div>
    </IssuesProvider>
  );
}
