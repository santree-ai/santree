/**
 * The Triage workspace: one ticket, in full, with its investigations as tabs
 * beside it and a rail of what it runs on.
 *
 * The queue is not here. It lives in the sidebar's Triage section
 * (`components/shell/TriageSection`), where a permanent rail can show it from
 * anywhere; this view is only what opens when you pick a ticket there. The
 * ticket rides in the route (`/triage?ticket=`) so that section can light the
 * row you are looking at — selection follows the route and nothing else.
 *
 * **Two repos, on purpose.** The queue and the ticket are read from one Linear
 * org — `useTriageOrgRepo`, the same read the sidebar makes, so a row and the
 * ticket it opens can't come from two orgs. Everything that *runs* — an
 * investigation, a terminal, the file and history panes in the rail — runs on
 * the ticket's attached project (`useTriageRepo`: its own pick, else the triage
 * default), on that project's main checkout and never on a worktree. A ticket
 * with no project to run on is asked for one, once, by the first action that
 * needs it (see {@link TriageRepoGateProvider}); every such action goes through
 * one `withRepo`, so the question is asked in one place and the answer means
 * one thing.
 *
 * With no ticket it says so and points at the sidebar. It used to show a
 * landing grid of the queue instead: a second copy of the list one click away
 * from the first.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentKind, TriageTicket } from "../../bindings";
import { DiscussionSkeleton } from "../../components/IssueDiscussion";
import { IssuePage } from "../../components/IssuePage";
import { AgentIcon } from "../../components/icons";
import { Button, EmptyState, TerminalActivity } from "../../components/primitives";
import {
  INVESTIGATE_AGENT_KEY,
  useRepos,
  useResolvedSetting,
  useSetting,
  useTriageDetail,
  useTriageOrgRepo,
  useTriageQueue,
  useTriageRepo,
} from "../../lib/queries";
import { usePersistedState } from "../../lib/usePersistedState";
import { useApp, useAppUi } from "../../state/AppContext";
import { agentProvider } from "../terminal/agentProvider";
import { useTriageKeyboard } from "./hooks";
import { InvestigatePane } from "./InvestigatePane";
import { TriageRepoGateProvider, useTriageRepoGate } from "./TriageRepoGate";
import { DEFAULT_W, type TriageRailTab, TriageSidePanel } from "./TriageSidePanel";
import { TriageTabBar } from "./TriageTabBar";
import { TriageTerminal } from "./TriageTerminal";
import { agentTabKind, type TriageTabs, useTriageTabs } from "./useTriageTabs";

const RIGHT_COLLAPSED_KEY = "santree.triage.right.collapsed";
const RIGHT_WIDTH_KEY = "santree.triage.right.width";

/** Which provider "Investigate" launches: the attached project's override when
 *  there is one, else the app default (Settings → Triage). The app read is what
 *  a ticket with no project yet resolves through — the ask has to name the
 *  provider the pick will actually launch. The prompt itself is the editable
 *  `triage` prompt, not a skill. */
function useInvestigateAgent(repo: string | null): AgentKind {
  const resolved = useResolvedSetting(repo ?? "", INVESTIGATE_AGENT_KEY);
  const app = useSetting("app", INVESTIGATE_AGENT_KEY);
  return ((repo ? resolved.data : app.data) as AgentKind | null) ?? "Codex";
}

export function TriageView() {
  const { triageEnabled } = useApp();
  const { triageFocus, consumeTriageFocus, requestTriageFocus } = useAppUi();
  const navigate = useNavigate();
  // `strict: false` because this view is also rendered in tests, where there is
  // no matched route to read a typed search off.
  const { ticket: ticketId } = useSearch({ strict: false }) as { ticket?: string };
  const orgRepo = useTriageOrgRepo();
  const { active, snoozed, loading } = useTriageQueue(orgRepo);
  // Every ticket the sidebar lists, in its order — what j/k step through.
  const ordered = useMemo(() => [...active, ...snoozed], [active, snoozed]);
  const ticket = ticketId ? (ordered.find((t) => t.id === ticketId) ?? null) : null;
  const { repo } = useTriageRepo(ticket?.id ?? null);
  const agentKind = useInvestigateAgent(repo);
  // Cached by the ticket page's own read; ⌘O needs the url off it.
  const { data: detail } = useTriageDetail(orgRepo, ticket?.id ?? null);
  // The rail's chrome outlives the ticket: it is a preference about this view,
  // not about any one workspace.
  const [rightCollapsed, setRightCollapsed] = usePersistedState(RIGHT_COLLAPSED_KEY, false);
  const [rightWidth, setRightWidth] = usePersistedState(RIGHT_WIDTH_KEY, DEFAULT_W);
  const toggleRight = useCallback(() => setRightCollapsed((c) => !c), [setRightCollapsed]);

  // Redirect away if triage gets disabled while open. Tickets, not the workspace:
  // the tickets you were triaging are all still there.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/issues" });
  }, [triageEnabled, navigate]);

  // A focus for a ticket this queue doesn't hold — filtered out by Mine, or
  // gone from triage since the agent ran — has no workspace to land in. Dropped
  // rather than kept, or it would fire the day that ticket is opened by hand.
  // Only once the route names it: the search param lags the navigation by a
  // render, and dropping on the frame it still shows the previous ticket is how
  // clicking an agent under ticket B while on A landed on B's Linear tab. Not
  // while loading either: the ticket may simply not have arrived yet.
  useEffect(() => {
    if (!triageFocus || loading || triageFocus.ticket !== ticketId || ticket) return;
    consumeTriageFocus();
  }, [triageFocus, loading, ticketId, ticket, consumeTriageFocus]);

  const select = useCallback(
    (id: string) => navigate({ to: "/triage", search: { ticket: id } }),
    [navigate],
  );
  // ⌘I takes the same handoff an agent row in the sidebar does: the workspace
  // for this ticket consumes it and opens the tab.
  const investigate = useCallback(() => {
    if (ticket) requestTriageFocus(ticket.id, agentKind);
  }, [ticket, agentKind, requestTriageFocus]);

  useTriageKeyboard({
    ordered,
    activeId: ticket?.id ?? null,
    detail: detail ?? undefined,
    onSelect: select,
    onInvestigate: investigate,
    onTogglePanel: toggleRight,
  });

  if (!ticket) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        {loading ? (
          // The queue hasn't landed, so "nothing in triage" isn't ours to say yet.
          <DiscussionSkeleton />
        ) : ticketId ? (
          // Named by the route but not in the queue: snoozed out by a filter, or
          // triaged since. Saying which ticket beats a generic "pick one" beside
          // a sidebar with nothing lit.
          <EmptyState
            title={`${ticketId} is no longer in triage`}
            subtitle="The Triage section in the sidebar lists what is waiting."
          />
        ) : ordered.length === 0 ? (
          <EmptyState title="Nothing in triage" subtitle="Your queue is clear." />
        ) : (
          <EmptyState
            title="Pick a ticket in the sidebar"
            subtitle="The Triage section lists what is waiting."
          />
        )}
      </div>
    );
  }

  // Both keyed by ticket: tab state starts over per ticket, and a pending
  // "which project?" is about the ticket it was asked for — it must not
  // outlive it and write the answer onto the next one.
  return (
    <TriageRepoGateProvider key={ticket.id} ticketId={ticket.id}>
      <TicketWorkspace
        key={ticket.id}
        orgRepo={orgRepo}
        ticket={ticket}
        agentKind={agentKind}
        rightCollapsed={rightCollapsed}
        onToggleRight={toggleRight}
        rightWidth={rightWidth}
        onRightWidth={setRightWidth}
      />
    </TriageRepoGateProvider>
  );
}

/**
 * One ticket's workspace: the tab strip, the ticket page, whichever
 * investigation or shell is in front, and the rail beside them.
 *
 * The ticket page stays mounted behind an agent tab (markdown and inline images
 * are expensive to re-parse); an investigation pane and the shell mount only
 * while showing — their PTYs live in the global terminal layer, and each pane
 * launches on mount, so it must be mounted exactly once per (ticket, provider)
 * while in front. Neither mounts before the attached project's path is known:
 * a pane that spawned first would spawn a cwd-less shell, and the orchestrator
 * would then hand every later mount that same pane instead of the agent.
 */
function TicketWorkspace({
  orgRepo,
  ticket,
  agentKind,
  rightCollapsed,
  onToggleRight,
  rightWidth,
  onRightWidth,
}: {
  /** The repo whose Linear org the ticket is read from. */
  orgRepo: string;
  ticket: TriageTicket;
  /** The provider the "Investigate" button launches. */
  agentKind: AgentKind;
  rightCollapsed: boolean;
  onToggleRight: () => void;
  rightWidth: number;
  onRightWidth: (w: number) => void;
}) {
  const { triageFocus, consumeTriageFocus } = useAppUi();
  // What runs, and where. `repo` is also what the stored investigations and the
  // ✕'s forget are read under — `terminal_sessions.repo` is written with it, so
  // any other repo would find nothing.
  const { repo, attached, defaultRepo, loading: repoLoading, setRepo } = useTriageRepo(ticket.id);
  const ask = useTriageRepoGate();
  const tabs = useTriageTabs(repo ?? "", ticket.id);
  const { data: repos = [] } = useRepos();
  // The project's root — the main checkout. The backend holds the same line:
  // `validate_agent_cwd` (src-tauri/src/commands.rs) refuses a `triage:` session
  // anywhere but the registered repository root, so this is not a choice the
  // frontend could get wrong quietly.
  const cwd = (repo && repos.find((r) => r.name === repo)?.path) || null;
  const activeAgent = agentTabKind(tabs.active);
  const showShell = tabs.active === "shell";
  const { openAgent, openShell, closeShell, select } = tabs;

  /** Run something on the ticket's project, asking for one first when there is
   *  none. The one gate every launch goes through: the Investigate button, the
   *  "+" rows, ⌘I and the sidebar's handoff all arrive here, so the question is
   *  asked in one place and a cancel means the same everywhere — nothing. */
  const withRepo = useCallback(
    (action: string, run: () => void) => {
      // Not an answer yet (see `useTriageRepo`): neither run nor ask on it.
      if (repoLoading) return;
      if (repo) {
        run();
        return;
      }
      void ask(action).then((picked) => {
        if (picked) run();
      });
    },
    [repo, repoLoading, ask],
  );
  const investigateWith = useCallback(
    (agent: AgentKind) =>
      withRepo(`Investigating with ${agentProvider(agent).label}`, () => openAgent(agent)),
    [withRepo, openAgent],
  );
  const openTerminal = useCallback(
    () => withRepo("Opening a terminal", openShell),
    [withRepo, openShell],
  );
  // The rail's own way in. Not through `withRepo`: it has nothing to run, and
  // with a project already attached it is a change, not a first attachment.
  const pickProject = useCallback(() => {
    void ask("Investigating this ticket");
  }, [ask]);
  // The strip gets the gated model: its rows open tabs, and a tab is a launch.
  const gatedTabs = useMemo<TriageTabs>(
    () => ({ ...tabs, openAgent: investigateWith, openShell: openTerminal }),
    [tabs, investigateWith, openTerminal],
  );

  // A handoff from elsewhere ("open this investigation", ⌘I): land on the tab
  // it names once and drop the request, so a later manual pick sticks. Only
  // this ticket's — the route already carries the ticket, so a request for
  // another one is not ours — and only once the project is known, or the
  // launch would land on the default when the ticket had picked otherwise.
  useEffect(() => {
    if (!triageFocus || triageFocus.ticket !== ticket.id || repoLoading) return;
    if (triageFocus.agent) investigateWith(triageFocus.agent);
    else select("linear");
    consumeTriageFocus();
  }, [triageFocus, ticket.id, repoLoading, investigateWith, select, consumeTriageFocus]);

  // The rail's pane, per workspace.
  const [rail, setRailTab] = useState<TriageRailTab>("files");
  const ready = !repoLoading && repo !== null && cwd !== null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      <TriageTabBar
        ticket={ticket}
        tabs={gatedTabs}
        rightCollapsed={rightCollapsed}
        onToggleRight={onToggleRight}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={activeAgent || showShell ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
            <IssuePage
              repo={orgRepo}
              ticketId={ticket.id}
              summary={ticket}
              actions={
                <InvestigateButton
                  agentKind={agentKind}
                  onClick={() => investigateWith(agentKind)}
                />
              }
            />
          </div>
          {activeAgent &&
            (ready ? (
              <InvestigatePane
                key={`${ticket.id}:${activeAgent}`}
                repo={repo}
                ticketId={ticket.id}
                cwd={cwd}
                agentKind={activeAgent}
                hasStartedSession={tabs.hasStored(activeAgent)}
                // A plain shell (no repo path) has nothing to resume when it
                // exits, so it falls back to the ticket; a real investigation
                // keeps its tab.
                onExited={() => select("linear")}
              />
            ) : (
              <Attaching />
            ))}
          {showShell &&
            (ready ? (
              <TriageTerminal ticketId={ticket.id} cwd={cwd} onExited={closeShell} />
            ) : (
              <Attaching />
            ))}
        </div>
        <TriageSidePanel
          repo={repo}
          attached={attached}
          defaultRepo={defaultRepo}
          onPickProject={pickProject}
          onDetach={() => setRepo(null)}
          tab={rail}
          onTabChange={setRailTab}
          collapsed={rightCollapsed}
          onToggle={onToggleRight}
          width={rightWidth}
          onWidth={onRightWidth}
        />
      </div>
    </div>
  );
}

/** A tab whose pane is waiting on the project: the frame between a pick and its
 *  path being known, or a live pane found before the attachment read landed. */
function Attaching() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <TerminalActivity label="Attaching the project…" />
    </div>
  );
}

/** The ticket page's one host action: open (or switch to) the default
 *  provider's investigation tab. */
function InvestigateButton({ agentKind, onClick }: { agentKind: AgentKind; onClick: () => void }) {
  const label = agentProvider(agentKind).label;
  return (
    <Button variant="tinted" size="sm" onClick={onClick} title={`Investigate with ${label}`}>
      <AgentIcon kind={agentKind} size={12} />
      Investigate with {label}
    </Button>
  );
}
