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
 * tickets are laid out. The page also owns the "Actionable only" filter and
 * the team pick, which both modes and their chords share: the list groups by
 * team when every team is showing, and the graph draws the picked team's
 * tickets through the same provider.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  ListIcon,
  TrackerLogo,
} from "../../components/icons";
import {
  Button,
  Dot,
  Dropdown,
  MENU_ITEM,
  Segmented,
  SwitchTrack,
} from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { usePersistedState } from "../../lib/usePersistedState";
import { CHROME } from "../../state/AppContext";
import { raisedActiveStyle, successColor } from "../../theme/colors";
import { IssuesProvider, useIssues } from "../issues/model";
import { RightPanel } from "../issues/RightPanel";
import { useIssuesShortcuts } from "../issues/shortcuts";
import { TicketsGraph } from "./TicketsGraph";
import { TicketsList } from "./TicketsList";
import {
  type TicketProjectGroup,
  type TicketSource,
  type TicketsSummary,
  type TicketTeam,
  useTickets,
  useUnlinkedConnections,
} from "./useTickets";

type Mode = "list" | "graph";

const MODE_KEY = "santree.tickets.mode";
const ACTIONABLE_KEY = "santree.tickets.actionableOnly";
/** The team pick — team keys, or `[]` for every team. Persisted as picked;
 *  the fold drops a key while it has no tickets and takes it back with them. */
const TEAMS_KEY = "santree.tickets.teams";
/** The source pick — a connection id, or `null` for every source. Persisted as
 *  picked; the fold ignores it while that connection has no tickets. */
const SOURCE_KEY = "santree.tickets.source";

const MODE_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon size={11} /> },
  { value: "graph" as const, label: "Graph", icon: <BranchIcon size={11} /> },
];

/** "128 across 6 projects · 14 ready · 9 blocked" — the page in one line. */
function summaryLine({ total, projects, ready, blocked }: TicketsSummary): string {
  const scope = `${total} across ${projects} project${projects === 1 ? "" : "s"}`;
  return `${scope} · ${ready} ready · ${blocked} blocked`;
}

/**
 * Which teams the page shows, as a menu on the strip: the trigger names the
 * pick — every team, one team, or how many — in the chip family of the
 * controls beside it, and the menu lists every team with its tally, each a
 * checkbox, so any set of them can be shown together. "All teams" clears the
 * pick and closes; a team toggles and stays open, since a set is built one
 * check at a time. It replaced a segmented control that spent a segment per
 * team on a strip that also has to hold the summary, the filter and the mode.
 * Drawn only once there are two teams to tell apart; with one, the page is
 * that team's and the control would name a choice that isn't there. Labels
 * are the team's name, falling back to its key (a blocker from a team you're
 * not on knows only its key).
 */
function TeamMenu({
  teams,
  picked,
  onChange,
}: {
  teams: TicketTeam[];
  picked: string[];
  onChange: (keys: string[]) => void;
}) {
  if (teams.length < 2) return null;
  const all = picked.length === 0;
  const nameOf = (key: string) => teams.find((t) => t.key === key)?.name ?? key;
  const label = all
    ? "All teams"
    : picked.length === 1
      ? nameOf(picked[0])
      : `${picked.length} teams`;
  const toggleTeam = (key: string) =>
    onChange(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);
  return (
    <Dropdown
      menuClassName="w-60 overflow-hidden"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`Teams: ${label}`}
          title="Which teams' tickets to show"
          className="flex h-6 max-w-48 flex-none cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 text-[11px] whitespace-nowrap text-fg-2 transition-colors hover:border-line-strong"
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon size={9} className="flex-none text-muted-3" />
        </button>
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={all}
            onClick={() => {
              onChange([]);
              close();
            }}
            className={MENU_ITEM}
          >
            {/* The check keeps its column whether or not it is drawn, so the
                rows' labels line up. */}
            <span className="flex h-4 w-3 flex-none items-center text-fg">
              {all && <CheckIcon size={11} />}
            </span>
            <span className={`min-w-0 flex-1 truncate ${all ? "text-fg" : ""}`}>All teams</span>
            <span className="font-mono text-[10px] text-muted-4 tabular-nums">
              {teams.reduce((sum, t) => sum + t.count, 0)}
            </span>
          </button>
          {teams.map((team) => {
            const checked = picked.includes(team.key);
            return (
              <button
                key={team.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => toggleTeam(team.key)}
                title={`Team ${team.key}`}
                className={MENU_ITEM}
              >
                <span className="flex h-4 w-3 flex-none items-center text-fg">
                  {checked && <CheckIcon size={11} />}
                </span>
                <span className={`min-w-0 flex-1 truncate ${checked ? "text-fg" : ""}`}>
                  {team.name ?? team.key}
                </span>
                <span className="font-mono text-[10px] text-muted-4 tabular-nums">
                  {team.count}
                </span>
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

/**
 * Which connection's tickets the page shows — "All sources", or one Linear org or
 * Jira site. One choice rather than a set: a source is a whole workspace, and the
 * graph can draw only one. Drawn only once two connections have tickets here;
 * with one, the page is that connection's and the control would name a choice
 * that isn't there. Same chip family as the team menu beside it.
 */
function SourceMenu({
  sources,
  picked,
  onChange,
}: {
  sources: TicketSource[];
  picked: string | null;
  onChange: (id: string | null) => void;
}) {
  if (sources.length < 2) return null;
  const current = sources.find((s) => s.id === picked) ?? null;
  const label = current?.label ?? "All sources";
  return (
    <Dropdown
      menuClassName="w-64 overflow-hidden"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`Source: ${label}`}
          title="Which connection's tickets to show"
          className="flex h-6 max-w-56 flex-none cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 text-[11px] whitespace-nowrap text-fg-2 transition-colors hover:border-line-strong"
        >
          {current && <TrackerLogo provider={current.provider} size={10} />}
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon size={9} className="flex-none text-muted-3" />
        </button>
      )}
    >
      {(close) => (
        <>
          {[{ id: null, label: "All sources", provider: null, count: null }, ...sources].map(
            (source) => {
              const checked = (source.id ?? null) === (current?.id ?? null);
              return (
                <button
                  key={source.id ?? "all"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => {
                    onChange(source.id);
                    close();
                  }}
                  className={MENU_ITEM}
                >
                  <span className="flex h-4 w-3 flex-none items-center text-fg">
                    {checked && <CheckIcon size={11} />}
                  </span>
                  {source.provider && <TrackerLogo provider={source.provider} size={10} />}
                  <span className={`min-w-0 flex-1 truncate ${checked ? "text-fg" : ""}`}>
                    {source.label}
                  </span>
                  <span className="font-mono text-[10px] text-muted-4 tabular-nums">
                    {source.count ?? sources.reduce((sum, s) => sum + s.count, 0)}
                  </span>
                </button>
              );
            },
          )}
        </>
      )}
    </Dropdown>
  );
}

/** Connections no project is linked to have no tickets here — the page reads
 *  through a project — so each is named, with the way to fix it, instead of being
 *  left out as though it were empty. */
function UnlinkedNotice() {
  const unlinked = useUnlinkedConnections();
  const navigate = useNavigate();
  if (unlinked.length === 0) return null;
  return (
    <div className="flex flex-none items-center gap-2 border-b border-line bg-deep px-3 py-1.5 text-[11.5px] text-muted-3">
      <span className="min-w-0 truncate">
        {unlinked.map((c) => c.label).join(", ")} {unlinked.length === 1 ? "has" : "have"} no
        project linked, so no tickets show here.
      </span>
      <button
        type="button"
        onClick={() => navigate({ to: "/settings", search: { scope: "repo", section: "tracker" } })}
        className="flex-none cursor-pointer text-fg-3 underline decoration-line-strong underline-offset-2 hover:text-fg"
      >
        Link one in Settings
      </button>
    </div>
  );
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
  const [teamPick, setTeamPick] = usePersistedState<string[]>(TEAMS_KEY, []);
  // `picked` is the pick in force: the stored keys that name a team with
  // tickets on the page — the provider and the menu both read it.
  const [sourcePick, setSourcePick] = usePersistedState<string | null>(SOURCE_KEY, null);
  const { groups, teams, picked, sources, source, sourceRepo, summary, loading } = useTickets(
    actionableOnly,
    teamPick,
    sourcePick,
  );

  const toggleActionable = useCallback(() => setActionableOnly((v) => !v), [setActionableOnly]);

  // Handed to the graph's model, which reads and writes the same filter from its
  // own in-canvas toggle — one state, two controls.
  const actionable = useMemo(
    () => ({ value: actionableOnly, set: setActionableOnly }),
    [actionableOnly, setActionableOnly],
  );

  return (
    <IssuesProvider actionable={actionable} teams={picked} scopeRepo={sourceRepo}>
      <TicketsShortcuts onToggleActionable={toggleActionable} />
      <TicketsPage
        mode={mode}
        onMode={setMode}
        actionableOnly={actionableOnly}
        onToggleActionable={toggleActionable}
        teams={teams}
        picked={picked}
        onTeams={setTeamPick}
        sources={sources}
        source={source}
        onSource={setSourcePick}
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
  teams,
  picked,
  onTeams,
  sources,
  source,
  onSource,
  groups,
  summary,
  loading,
}: {
  mode: Mode;
  onMode: (mode: Mode) => void;
  actionableOnly: boolean;
  onToggleActionable: () => void;
  teams: TicketTeam[];
  picked: string[];
  onTeams: (keys: string[]) => void;
  sources: TicketSource[];
  source: string | null;
  onSource: (id: string | null) => void;
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
          <SourceMenu sources={sources} picked={source} onChange={onSource} />
          <TeamMenu teams={teams} picked={picked} onChange={onTeams} />
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

        <UnlinkedNotice />

        <div className="relative flex min-h-0 min-w-0 flex-1">
          {mode === "list" ? (
            <TicketsList groups={groups} loading={loading} showSource={sources.length > 1} />
          ) : (
            <TicketsGraph />
          )}
        </div>
      </div>
      <RightPanel />
    </div>
  );
}
