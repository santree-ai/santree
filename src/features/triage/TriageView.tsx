/**
 * The Triage tab. The left rail is the untriaged queue (snoozed issues greyed
 * and sunk to the bottom) plus the team on-call schedule. The main pane renders
 * the selected Linear issue: its description (markdown + images) and comment
 * thread. "Investigate" opens a real terminal in the repo for now (an
 * auto-invoked investigate skill comes later).
 *
 * This is a thin orchestrator: data hooks + the extracted triage hooks (see
 * `hooks.ts`) + the JSX (queue list + detail pane). The detail bodies are
 * expensive (markdown + inline images), so `useKeptPanes` keeps recently-viewed
 * panes mounted and just toggles visibility, mounting new ones under a
 * transition — revisiting a ticket is instant, and the first heavy paint never
 * blocks the click.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AgentKind, TriageTicket } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import { AgentIcon } from "../../components/icons";
import { Button, EmptyState, Segmented, Skeleton } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import {
  CLAUDE_REMOTE_CONTROL_KEY,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_PERMISSION_MODE_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  useBaseWorktree,
  useLinearReadOnly,
  usePrefetchOnHover,
  useRefreshTriage,
  useRepos,
  useResolvedProviderSetting,
  useResolvedSetting,
  useSetSetting,
  useStartedInvestigations,
  useTriageDetail,
  useTriageQueue,
  useTriageSchedule,
  useTriageSetState,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { accentActiveStyle, alpha } from "../../theme/colors";
import { agentProvider } from "../terminal/agentProvider";
import { useTerminals } from "../terminal/TerminalsContext";
import { DetailTabs } from "./DetailTabs";
import {
  useBatchInvestigate,
  useInvestigateSelection,
  useKeptPanes,
  useTabByTicket,
  useTriageKeyboard,
  useTriageSelection,
} from "./hooks";
import { InvestigatePane } from "./InvestigatePane";
import { IssueHeader } from "./IssueHeader";
import { orderedProviders, providersByRef, triageTerminalRef } from "./providerSessions";
import { QueueRow } from "./QueueRow";
import { RepoSessionPane } from "./RepoSessionPane";
import { ScheduleSection } from "./ScheduleSection";

/**
 * The repo-session row at the top of the rail. Selecting it opens a provider
 * session on the base checkout that isn't attached to any ticket.
 *
 * The provider mark reflects the current default while the detail surface can
 * retain simultaneous provider tabs.
 */
function RepoSessionEntry({
  agentKind,
  active,
  onSelect,
}: {
  agentKind: AgentKind;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className="entity-card relative mb-2 flex items-center gap-2.5 px-[11px] py-2.5 text-[12px]"
      data-active={active}
      style={{
        color: active ? "var(--accent)" : "var(--color-muted-2)",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open Triage desk with ${agentProvider(agentKind).label}`}
        title={`Open the Triage desk with ${agentProvider(agentKind).label}`}
        className="absolute inset-0 cursor-pointer rounded-[9px]"
      />
      <span
        className="flex h-7 w-7 flex-none items-center justify-center rounded-[var(--radius-sm)] border border-line-2 bg-input text-[14px]"
        aria-hidden
      >
        👋
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-medium text-fg-2">Triage desk</span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted-4">
          permanent workspace
        </span>
      </span>
      <AgentIcon kind={agentKind} size={12} className="relative flex-none" />
    </div>
  );
}

/** How many recently-viewed discussion panes to keep mounted (hidden). */
const MAX_KEPT_PANES = 6;

/** Placeholder queue rows for the cold load, so an unresolved queue never renders
 *  as "all caught up" (mirrors the Reviews sidebar's skeleton). */
function QueueSkeleton() {
  return (
    <div className="mt-1.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="mb-[5px] rounded-[9px] px-[11px] py-2.5">
          <Skeleton className="mb-2 h-2.5 w-12" />
          <Skeleton className="mb-2 h-3 w-4/5" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Shown when your triage queue resolves to nothing — a calm "all caught up"
 * state. If issues are still waiting in the team inbox, it nudges you toward the
 * "Be a good citizen" setting with a link straight to it.
 */
function AllCaughtUp({
  goodCitizen,
  teamWaiting,
  onTriage,
}: {
  goodCitizen: boolean;
  teamWaiting: number;
  onTriage: { name: string; avatarUrl: string | null } | null;
}) {
  const navigate = useNavigate();
  const offer = !goodCitizen && teamWaiting > 0;
  const firstName = onTriage?.name.split(" ")[0];

  const goodCitizenLink = (
    <button
      type="button"
      onClick={() => navigate({ to: "/settings", search: { section: "actions" } })}
      className="cursor-pointer font-medium underline decoration-dotted underline-offset-2 hover:brightness-110"
      style={{ color: "var(--accent-text)" }}
    >
      Be a good citizen
    </button>
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {offer && onTriage ? (
        <div className="relative mb-1">
          <Avatar name={onTriage.name} src={onTriage.avatarUrl} size={62} />
          <span
            className="absolute -bottom-1.5 -left-2 text-[26px] leading-none"
            style={{ animation: "wave 1.8s ease-in-out infinite", transformOrigin: "25% 80%" }}
          >
            👋
          </span>
        </div>
      ) : (
        <div
          className="flex h-[64px] w-[64px] items-center justify-center rounded-full"
          style={{ background: alpha(12) }}
        >
          <span className="text-[30px] leading-none">🌱</span>
        </div>
      )}
      <div className="text-[17px] font-semibold text-fg-bright">All caught up</div>
      {offer ? (
        <div className="max-w-[312px] text-[12.5px] leading-[1.6] text-muted-3">
          <span className="font-medium text-fg-2">
            Feeling generous{firstName ? ` toward ${firstName}` : ""}?
          </span>{" "}
          {teamWaiting} {teamWaiting === 1 ? "issue is" : "issues are"}{" "}
          {firstName ? "piling up on triage" : "waiting on the team"}. Turn on {goodCitizenLink} to
          help.
        </div>
      ) : (
        <div className="text-[12.5px] text-muted-3">Nothing in your triage queue.</div>
      )}
    </div>
  );
}

export function TriageView() {
  const { triageEnabled, activeRepo } = useApp();
  const { triageFocus, consumeTriageFocus } = useAppUi();
  const navigate = useNavigate();
  const { data: schedules = [] } = useTriageSchedule(activeRepo);
  const { visible, teamWaiting, goodCitizen, loading } = useTriageQueue(activeRepo);
  const setSetting = useSetSetting();
  // The Mine/All header toggle *is* the "be a good citizen" setting — All widens
  // to the whole team inbox (issues not assigned to you included).
  const setGoodCitizen = (next: boolean) =>
    setSetting.mutate({ scope: "app", key: TRIAGE_GOOD_CITIZEN_KEY, value: next ? "true" : null });
  // Who's currently on triage (someone other than me) — drives the empty-state
  // nudge to lend them a hand.
  const onTriageShift = schedules.find((s) => s.currentName && !s.currentIsMe);
  const onTriage = onTriageShift
    ? { name: onTriageShift.currentName ?? "", avatarUrl: onTriageShift.currentAvatarUrl }
    : null;
  const { data: repos = [] } = useRepos();
  // Warm a ticket's detail on hover so the click renders instantly.
  const onHoverRow = usePrefetchOnHover(activeRepo);
  const setState = useTriageSetState(activeRepo);
  // A read-only Linear grant leaves everything here readable; only the writes go.
  const linearReadOnly = useLinearReadOnly(activeRepo);
  const repoPath = repos.find((r) => r.name === activeRepo)?.path ?? undefined;

  // The Triage Investigation action config for this repo (repo override, else
  // the app default): which agent runs it, and which model/effort. The prompt
  // itself is the editable `triage` prompt (Settings → Prompts), not a skill.
  const { data: investigateAgent } = useResolvedSetting(activeRepo, INVESTIGATE_AGENT_KEY);
  const agentKind = (investigateAgent as AgentKind | null) ?? "Codex";
  const { data: investigateModel } = useResolvedProviderSetting(
    activeRepo,
    INVESTIGATE_MODEL_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );
  const { data: investigateEffort } = useResolvedProviderSetting(
    activeRepo,
    INVESTIGATE_EFFORT_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );
  const { data: investigatePermissionMode } = useResolvedProviderSetting(
    activeRepo,
    INVESTIGATE_PERMISSION_MODE_KEY,
    agentKind,
    INVESTIGATE_AGENT_KEY,
  );

  const { tabs: terminalTabs } = useTerminals();

  const hasLiveProvider = useCallback(
    (refId: string, provider: AgentKind) =>
      terminalTabs.some(
        (tab) => tab.source === "triage" && tab.refId === triageTerminalRef(refId, provider),
      ),
    [terminalTabs],
  );
  // Tickets with a stored session from a past investigation (persists across app
  // restarts) — they get the tab + resume affordance even when not live.
  const { data: storedSessions = [] } = useStartedInvestigations(activeRepo);
  const startedInvestigations = useMemo(() => providersByRef(storedSessions), [storedSessions]);
  const providersFor = useCallback(
    (refId: string) =>
      orderedProviders(
        new Set([
          ...(startedInvestigations.get(refId) ?? []),
          ...(["Codex", "Claude"] as AgentKind[]).filter((provider) =>
            hasLiveProvider(refId, provider),
          ),
        ]),
      ),
    [startedInvestigations, hasLiveProvider],
  );
  const hasAnyLiveProvider = useCallback(
    (refId: string) => providersFor(refId).some((provider) => hasLiveProvider(refId, provider)),
    [providersFor, hasLiveProvider],
  );

  // Investigations float above the backlog — a running agent first, then a
  // resumable one — because that's in-flight work you're likely to return to,
  // regardless of where SLA puts it. Snoozed still sinks to the bottom (matching
  // the CLI). `sort` is stable, so SLA order holds within each rank.
  const rank = useCallback(
    (t: TriageTicket) => {
      if (t.snoozedUntilMs != null) return 3;
      if (hasAnyLiveProvider(t.id)) return 0;
      if (startedInvestigations.has(t.id)) return 1;
      return 2;
    },
    [hasAnyLiveProvider, startedInvestigations],
  );
  const ordered = useMemo(() => [...visible].sort((a, b) => rank(a) - rank(b)), [visible, rank]);
  // Group by team, preserving order. Only used when the queue spans >1 team.
  const groups = useMemo(() => {
    const map = new Map<string, TriageTicket[]>();
    for (const t of ordered) {
      const key = t.team ?? "Other";
      const list = map.get(key);
      if (list) list.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()];
  }, [ordered]);
  const grouped = groups.length > 1;

  // The selected ticket, kept valid as the queue loads / changes.
  const { activeId, activeTicket, select } = useTriageSelection(ordered, visible);

  // The repo session is its own selection, not a ticket id: `useTriageSelection`
  // snaps any id that isn't in the visible queue back to the first ticket, so a
  // sentinel threaded through it could never stay selected.
  const [repoSessionOpen, setRepoSessionOpen] = useState(false);
  const [repoSessionAgent, setRepoSessionAgent] = useState<AgentKind>(agentKind);
  const { data: baseWorktree } = useBaseWorktree(activeRepo);
  const selectTicket = useCallback(
    (id: string) => {
      setRepoSessionOpen(false);
      select(id);
    },
    [select],
  );
  const openRepoSession = useCallback(() => {
    setRepoSessionAgent(agentKind);
    setRepoSessionOpen(true);
  }, [agentKind]);

  // Header and body both key off `activeId`, so they switch together in one
  // render — never a new title over the previous ticket's content.
  const { data: detail } = useTriageDetail(activeRepo, activeId);
  const { refresh, fetching: refreshing } = useRefreshTriage(activeRepo, activeId);

  // Recently-viewed discussion panes stay mounted (hidden) so revisiting a
  // ticket is instant; new panes mount under a transition so the first heavy
  // render never blocks the click. Keyed on `activeRepo` so switching repos
  // drops the whole cache instead of carrying old-repo details along.
  const { keptPanes, detailFor } = useKeptPanes(detail, MAX_KEPT_PANES, activeRepo);

  // Batch investigation: tickets are eligible while not snoozed and not already
  // running one; the checkbox selection mirrors the Issues launch queue.
  // Investigation just needs a local repo path to run the agent in — the prompt
  // is always available (the built-in `triage` prompt, editable in Settings).
  const canInvestigate = !!repoPath;
  const eligibleIds = useMemo(
    () =>
      ordered
        .filter((t) => t.snoozedUntilMs == null && !hasLiveProvider(t.id, agentKind))
        .map((t) => t.id),
    [ordered, hasLiveProvider, agentKind],
  );
  // Rows test membership on every render — a Set keeps that off the O(n²) path.
  const eligible = useMemo(() => new Set(eligibleIds), [eligibleIds]);
  const { selected, toggle, clear, selectAll } = useInvestigateSelection(eligibleIds);
  const selectedIds = useMemo(
    () => eligibleIds.filter((id) => selected[id]),
    [eligibleIds, selected],
  );
  const allEligibleSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selected[id]);
  const { data: remoteControlSetting } = useResolvedSetting(activeRepo, CLAUDE_REMOTE_CONTROL_KEY);
  const batchInvestigate = useBatchInvestigate({
    repo: activeRepo,
    cwd: repoPath,
    agentKind,
    model: investigateModel ?? null,
    effort: investigateEffort ?? null,
    permissionMode: investigatePermissionMode ?? null,
    remoteControl: remoteControlSetting !== "false",
  });
  const investigateSelected = () => {
    const ids = selectedIds;
    clear();
    void batchInvestigate(ids);
  };

  // Per-ticket detail-tab memory (Discussion vs Investigation), so an open
  // investigation survives navigating away and back.
  const { tabFor, setTab } = useTabByTicket();
  const selectedTab = tabFor(activeId);
  const activeProviders = activeTicket ? providersFor(activeTicket.id) : [];
  const activeAgent = selectedTab === "discussion" ? null : selectedTab;
  const activeHasStarted =
    !!activeTicket &&
    !!activeAgent &&
    (startedInvestigations.get(activeTicket.id)?.has(activeAgent) ?? false);
  // Show the Investigation tab when it's live, has a resumable stored session, or
  // the user is actively on it — so past investigations surface a tab + resume.
  const shownProviders = orderedProviders(
    new Set([...activeProviders, ...(activeAgent ? [activeAgent] : [])]),
  );
  const showInvestigation = shownProviders.length > 0;
  const investigate = useCallback(() => setTab(activeId, agentKind), [setTab, activeId, agentKind]);
  // When the investigate terminal exits, fall back to this ticket's discussion.
  const backToDiscussion = useCallback(() => setTab(activeId, "discussion"), [setTab, activeId]);

  // Redirect away if triage gets disabled while open.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/" });
  }, [triageEnabled, navigate]);

  // A ticket handed over from the Agents panel ("open this investigation"):
  // select it once and drop the request, so a later manual selection sticks.
  useEffect(() => {
    if (!triageFocus) return;
    selectTicket(triageFocus);
    setTab(triageFocus, agentKind);
    consumeTriageFocus();
  }, [triageFocus, selectTicket, setTab, consumeTriageFocus, agentKind]);

  // Vim-style queue navigation (j/k, ⌘I, ⌘O).
  // j/k must land you back on the queue, not scroll it behind an open session.
  useTriageKeyboard({
    ordered,
    activeId,
    detail,
    onSelect: selectTicket,
    onInvestigate: investigate,
  });

  const renderRow = (t: TriageTicket) => (
    <QueueRow
      key={t.id}
      ticket={t}
      active={t.id === activeId}
      selectable={canInvestigate && eligible.has(t.id)}
      selected={!!selected[t.id]}
      investigating={hasAnyLiveProvider(t.id)}
      started={startedInvestigations.has(t.id)}
      agentKinds={providersFor(t.id)}
      onSelect={selectTicket}
      onToggleSelect={toggle}
      onHover={onHoverRow}
    />
  );

  return (
    <ViewChrome
      sidebar={
        <>
          {/* Header (scope toggle + count + Select all). Shown whenever there's a
              queue OR team issues to widen to, so the Mine/All toggle is reachable
              even when your own queue is empty. */}
          {(ordered.length > 0 || teamWaiting > 0) && (
            // `items-center` with an explicit control height, never `items-stretch`:
            // stretching makes the controls *be* the row, so they run edge to edge
            // between the two hairlines with no air around them, however short the
            // row is. Both carry the same height so they read as one pair.
            <div className="flex h-9 flex-none items-center gap-2 border-b border-hairline px-3">
              <Segmented
                options={[
                  { value: "mine", label: "Mine" },
                  { value: "all", label: "All" },
                ]}
                value={goodCitizen ? "all" : "mine"}
                onChange={(v) => setGoodCitizen(v === "all")}
                className="h-[26px] flex-1"
              />
              <Button
                size="sm"
                onClick={selectAll}
                disabled={!canInvestigate || eligibleIds.length === 0}
                title={
                  canInvestigate
                    ? "Select every ticket for investigation"
                    : "Configure the Investigation action in Settings first"
                }
                className="h-[26px] flex-none"
                style={allEligibleSelected ? accentActiveStyle() : undefined}
              >
                Select all
                {eligibleIds.length > 0 && (
                  <span className="font-mono text-[9.5px] opacity-70">{eligibleIds.length}</span>
                )}
              </Button>
            </div>
          )}
          <ScheduleSection schedules={schedules} />
          <div className="flex-1 overflow-y-auto p-2">
            {/* Above the queue, like Trees' base entry: the one row here that
                isn't a ticket. Needs the base branch's name, so it waits for
                that read rather than rendering a nameless row. */}
            {baseWorktree && (
              <RepoSessionEntry
                agentKind={agentKind}
                active={repoSessionOpen}
                onSelect={openRepoSession}
              />
            )}
            {loading ? (
              <QueueSkeleton />
            ) : ordered.length === 0 ? (
              <EmptyState className="py-8" title="Nothing in triage." />
            ) : grouped ? (
              groups.map(([team, items]) => (
                <div key={team} className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                    {team}
                    <span className="text-muted-5">{items.length}</span>
                  </div>
                  {items.map(renderRow)}
                </div>
              ))
            ) : (
              ordered.map(renderRow)
            )}
          </div>
          {selectedIds.length > 0 && (
            <div className="flex flex-none items-center gap-1.5 border-t border-hairline p-2">
              <Button variant="primary" onClick={investigateSelected} className="min-w-0 flex-1">
                Investigate {selectedIds.length} {selectedIds.length === 1 ? "ticket" : "tickets"}
              </Button>
              <Button variant="ghost" onClick={clear} title="Clear selection" className="flex-none">
                Clear
              </Button>
            </div>
          )}
          <SidebarFooter />
        </>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        {repoSessionOpen && baseWorktree ? (
          // Takes the whole detail area — there's no ticket to head it with, and
          // the queue is still one click away in the rail. Runs the same agent
          // config the Investigation action uses, since it's the Triage view's
          // agent either way.
          <div className="flex min-h-0 flex-1 flex-col">
            <DetailTabs
              tab={repoSessionAgent}
              includeDiscussion={false}
              providers={orderedProviders(
                new Set([...providersFor(`__repo__:${activeRepo}`), repoSessionAgent]),
              )}
              onTab={(tab) => {
                if (tab !== "discussion") setRepoSessionAgent(tab);
              }}
            />
            <RepoSessionPane
              key={repoSessionAgent}
              repo={activeRepo}
              branch={baseWorktree.branch}
              cwd={repoPath}
              agentKind={repoSessionAgent}
            />
          </div>
        ) : loading ? (
          // The queue hasn't landed yet, so we don't know there's nothing to
          // triage — "All caught up" here would be a cheerful lie.
          <DiscussionSkeleton />
        ) : !activeTicket ? (
          <AllCaughtUp goodCitizen={goodCitizen} teamWaiting={teamWaiting} onTriage={onTriage} />
        ) : (
          <>
            {/* Header renders instantly from the queue row; richer fields
                (author, labels, status) fill in when the detail loads. */}
            <IssueHeader
              ticket={activeTicket}
              detail={detail?.id === activeTicket.id ? detail : undefined}
              onSetState={(stateId) => setState.mutate({ ticketId: activeTicket.id, stateId })}
              linearReadOnly={linearReadOnly}
              investigating={selectedTab !== "discussion"}
              agentKind={agentKind}
              onInvestigate={investigate}
              onRefresh={refresh}
              refreshing={refreshing}
            />
            {/* The tab bar appears only once an investigation is started. */}
            {showInvestigation && (
              <DetailTabs
                tab={selectedTab}
                providers={shownProviders}
                onTab={(t) => setTab(activeId, t)}
              />
            )}
            {/* Kept discussion panes stay mounted (hidden) so revisiting a ticket
                is instant; only the active one (on the Discussion tab) is shown. */}
            {keptPanes.map((id) => {
              const d = id === activeId ? detail : detailFor(id);
              if (!d) return null;
              const shown = id === activeId && selectedTab === "discussion";
              return (
                <div key={id} className={shown ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <DiscussionPane detail={d} repo={activeRepo} />
                </div>
              );
            })}
            {/* Skeleton only on a first load — until the active ticket's pane is
                mounted into the kept-panes cache (which happens under a
                transition, so its heavy paint never blocks the click). */}
            {selectedTab === "discussion" && !keptPanes.includes(activeTicket.id) && (
              <DiscussionSkeleton />
            )}
            {activeAgent && (
              <InvestigatePane
                key={`${activeTicket.id}:${activeAgent}`}
                repo={activeRepo}
                ticketId={activeTicket.id}
                cwd={repoPath}
                agentKind={activeAgent}
                hasStartedSession={activeHasStarted}
                onExited={backToDiscussion}
              />
            )}
          </>
        )}
      </div>
    </ViewChrome>
  );
}
