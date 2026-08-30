/**
 * The Triage view. Its own left column is the untriaged queue (snoozed issues
 * greyed and sunk to the bottom) plus the team on-call schedule; the pane to its
 * right renders the selected Linear issue: its description (markdown + images)
 * and comment thread. "Investigate" opens a real terminal in the repo for now (an
 * auto-invoked investigate skill comes later). Window chrome and app navigation
 * are the app shell's — this view renders only its two columns.
 *
 * This is a thin orchestrator: data hooks + the extracted triage hooks (see
 * `hooks.ts`) + the JSX (queue list + detail pane). The detail bodies are
 * expensive (markdown + inline images), so `useKeptPanes` keeps recently-viewed
 * panes mounted and just toggles visibility, mounting new ones under a
 * transition — revisiting a ticket is instant, and the first heavy paint never
 * blocks the click.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentKind, SessionState, TriageTicket } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import { TelescopeIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import {
  Button,
  ChevronSelect,
  EmptyState,
  Segmented,
  Skeleton,
} from "../../components/primitives";
import { SlaCountdown } from "../../components/RelativeTime";
import { PriorityBars } from "../../components/WorkSignals";
import {
  CLAUDE_REMOTE_CONTROL_KEY,
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_PERMISSION_MODE_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  useLinearReadOnly,
  usePrefetchOnHover,
  useRefreshTriage,
  useRepos,
  useResolvedProviderSetting,
  useResolvedSetting,
  useSessionStates,
  useSetSetting,
  useSetting,
  useStartedInvestigations,
  useTriageDetail,
  useTriageQueue,
  useTriageSchedule,
  useTriageSetSortOrder,
  useTriageSetState,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { accentActiveStyle, alpha } from "../../theme/colors";
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
import {
  manualRankAt,
  moveTicket,
  parseTriageOrder,
  TRIAGE_ORDER_KEY,
  TRIAGE_ORDER_OPTIONS,
  type TriageLanes,
  triageLanes,
} from "./order";
import { orderedProviders, providersByRef, triageTermKey } from "./providerSessions";
import { QueueRow } from "./QueueRow";
import { ScheduleSection } from "./ScheduleSection";

/** Width of the queue column. Fixed: the resizable app sidebar belongs to the
 *  shell, and the queue is a list of uniform rows rather than a nested tree. */
const QUEUE_WIDTH = 300;

function QueueLaneHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-1 pb-1 font-mono text-[8.5px] tracking-[.08em] text-muted-5 uppercase">
      <span>{label}</span>
      <span>{count}</span>
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

/** Deliberate no-selection state for a non-empty queue. It keeps the playful
 * triage voice while turning the empty canvas into a concise pickup surface. */
function TriageHome({
  tickets,
  onSelect,
  onTriage,
}: {
  tickets: TriageTicket[];
  onSelect: (id: string) => void;
  onTriage: { name: string; avatarUrl: string | null } | null;
}) {
  const next = tickets.filter((ticket) => ticket.snoozedUntilMs == null).slice(0, 4);
  const firstName = onTriage?.name.split(" ")[0];

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10">
      <div className="w-full max-w-[720px]">
        <div className="mb-7 flex items-start gap-4">
          <span className="relative flex h-11 w-11 flex-none items-center justify-center rounded-[var(--radius-lg)] border border-line-2 bg-raised text-accent">
            <TelescopeIcon size={19} />
            <span className="absolute -right-1.5 -bottom-1 text-[16px] leading-none">🌱</span>
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[18px] font-semibold tracking-[-.01em] text-fg-bright">
              Triage desk
            </h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-muted-3">
              {tickets.length} {tickets.length === 1 ? "issue is" : "issues are"} waiting
              {firstName ? ` while ${firstName} covers the rotation` : " in the queue"}. Pick one to
              understand it before deciding where it belongs.
            </p>
          </div>
          {onTriage && <Avatar name={onTriage.name} src={onTriage.avatarUrl} size={38} />}
        </div>

        {next.length > 0 && (
          <div>
            <div className="mb-2 font-mono text-[9px] tracking-[.08em] text-muted-4 uppercase">
              Pick up next
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {next.map((ticket) => (
                <button
                  key={ticket.id}
                  type="button"
                  onClick={() => onSelect(ticket.id)}
                  className="entity-card cursor-pointer p-3 text-left"
                >
                  <span className="flex items-center gap-2 font-mono text-[9.5px] text-muted-4">
                    <span>{ticket.id}</span>
                    {ticket.priority !== "None" && <PriorityBars priority={ticket.priority} />}
                    {ticket.slaBreachMs != null && (
                      <SlaCountdown
                        breachMs={ticket.slaBreachMs}
                        className="ml-auto font-mono text-[9.5px]"
                      />
                    )}
                  </span>
                  <MarkdownTitle className="mt-1.5 block line-clamp-2 text-[11.5px] leading-4 text-fg-2">
                    {ticket.title}
                  </MarkdownTitle>
                  {ticket.team && (
                    <span className="mt-2 block font-mono text-[9px] text-muted-4">
                      {ticket.team}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 font-mono text-[10px] text-muted-4">
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">J</kbd>next
            issue
          </span>
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">K</kbd>
            previous issue
          </span>
          <span>
            <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘K</kbd>find
            anything
          </span>
          <span className="ml-auto">investigations stay attached to their ticket</span>
        </div>
      </div>
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
  const { data: sessionStates = [] } = useSessionStates();

  // A logical triage terminal is stable across provider tabs. Keep the newest
  // structured state available for each provider; QueueRow combines it with
  // terminal liveness for providers whose CLI has no finer-grained state event.
  const activityByTicket = useMemo(() => {
    const result = new Map<string, SessionState[]>();
    const newest = new Map<string, SessionState>();
    for (const state of sessionStates) {
      if (state.repo !== activeRepo || !state.termKey?.startsWith("triage:")) continue;
      const ticketId = state.termKey.slice("triage:".length);
      if (!ticketId) continue;
      const key = `${ticketId}:${state.agentKind}`;
      const seen = newest.get(key);
      if (!seen || (state.updatedAtMs ?? 0) > (seen.updatedAtMs ?? 0)) newest.set(key, state);
    }
    for (const state of newest.values()) {
      const ticketId = state.termKey?.slice("triage:".length);
      if (!ticketId) continue;
      const states = result.get(ticketId) ?? [];
      states.push(state);
      result.set(ticketId, states);
    }
    return result;
  }, [activeRepo, sessionStates]);

  // A ticket can have one live investigation per provider, so a pane is found by
  // the pair: the surface's `term_key` and the agent running in it.
  const hasLiveProvider = useCallback(
    (refId: string, provider: AgentKind) =>
      terminalTabs.some(
        (tab) =>
          tab.source === "triage" &&
          tab.refId === triageTermKey(refId) &&
          tab.agent?.kind === provider,
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

  const { data: storedOrder } = useSetting("app", TRIAGE_ORDER_KEY);
  const order = parseTriageOrder(storedOrder);
  const setSortOrder = useTriageSetSortOrder(activeRepo);

  // Activity is a lane, not an invisible sort override: running sessions and
  // resumable investigations stay findable without making Due date or Manual
  // claim an ordering the screen does not actually honor.
  const activityRank = useCallback(
    (t: TriageTicket) => {
      if (hasAnyLiveProvider(t.id)) return 0;
      if (startedInvestigations.has(t.id)) return 1;
      return 2;
    },
    [hasAnyLiveProvider, startedInvestigations],
  );
  const groups = useMemo(() => {
    const map = new Map<string, TriageTicket[]>();
    for (const t of visible) {
      const key = t.team ?? "Other";
      const list = map.get(key);
      if (list) list.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()].map(([team, tickets]) => ({
      team,
      lanes: triageLanes(tickets, order, activityRank),
    }));
  }, [visible, order, activityRank]);
  const grouped = groups.length > 1;

  type DragState = { movedId: string; team: string; items: TriageTicket[]; startIndex: number };
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const setCurrentDrag = useCallback((next: DragState | null) => {
    dragStateRef.current = next;
    setDragState(next);
  }, []);

  const renderedGroups = useMemo(
    () =>
      groups.map((group) => {
        if (!dragState || dragState.team !== group.team) return group;
        return { ...group, lanes: { ...group.lanes, queue: dragState.items } };
      }),
    [groups, dragState],
  );
  const ordered = useMemo(
    () =>
      renderedGroups.flatMap(({ lanes }) => [
        ...lanes.investigations,
        ...lanes.queue,
        ...lanes.snoozed,
      ]),
    [renderedGroups],
  );

  const startManualDrag = useCallback(
    (ticketId: string) => {
      const group = groups.find(({ lanes }) => lanes.queue.some(({ id }) => id === ticketId));
      if (group) {
        setCurrentDrag({
          movedId: ticketId,
          team: group.team,
          items: group.lanes.queue,
          startIndex: group.lanes.queue.findIndex(({ id }) => id === ticketId),
        });
      }
    },
    [groups, setCurrentDrag],
  );
  const dragManualOver = useCallback(
    (overId: string) => {
      const current = dragStateRef.current;
      if (!current?.items.some(({ id }) => id === overId)) return;
      const next = { ...current, items: moveTicket(current.items, current.movedId, overId) };
      setCurrentDrag(next);
    },
    [setCurrentDrag],
  );
  const persistManualOrder = useCallback(
    (items: TriageTicket[], movedId: string) => {
      const index = items.findIndex(({ id }) => id === movedId);
      const sortOrder = index >= 0 ? manualRankAt(items, index) : null;
      if (sortOrder == null) {
        toast.error("That position is too close to its neighbors. Refresh and try again.");
        return;
      }
      const previousSortOrder = items[index]?.sortOrder;
      setSortOrder.mutate(
        { ticketId: movedId, sortOrder },
        {
          onSuccess: () =>
            toast.success(`Moved ${movedId} in the manual order.`, {
              action:
                previousSortOrder == null
                  ? undefined
                  : {
                      label: "Undo",
                      onClick: () =>
                        setSortOrder.mutate({ ticketId: movedId, sortOrder: previousSortOrder }),
                    },
            }),
        },
      );
    },
    [setSortOrder],
  );
  const finishManualDrag = useCallback(() => {
    const current = dragStateRef.current;
    if (!current) return;
    setCurrentDrag(null);
    if (current.items.findIndex(({ id }) => id === current.movedId) === current.startIndex) return;
    persistManualOrder(current.items, current.movedId);
  }, [persistManualOrder, setCurrentDrag]);
  const moveManualWithKeyboard = useCallback(
    (ticketId: string, direction: -1 | 1) => {
      const group = groups.find(({ lanes }) => lanes.queue.some(({ id }) => id === ticketId));
      if (!group) return;
      const index = group.lanes.queue.findIndex(({ id }) => id === ticketId);
      const target = group.lanes.queue[index + direction];
      if (!target) return;
      const items = moveTicket(group.lanes.queue, ticketId, target.id);
      persistManualOrder(items, ticketId);
    },
    [groups, persistManualOrder],
  );

  // The selected ticket, kept valid as the queue loads / changes.
  const { activeId, activeTicket, select } = useTriageSelection(visible);

  // Header and body both key off `activeId`, so they switch together in one
  // render — never a new title over the previous ticket's content.
  // Every id here came out of Linear's own queue, so "no such issue" isn't a state
  // this view can reach — a `null` would only mean the org went away mid-session,
  // which reads the same as not loaded.
  const { data: liveDetail } = useTriageDetail(activeRepo, activeId);
  const detail = liveDetail ?? undefined;
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

  // Redirect away if triage gets disabled while open. Tickets, not the workspace:
  // the tickets you were triaging are all still there.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/issues" });
  }, [triageEnabled, navigate]);

  // A ticket handed over from elsewhere ("open this investigation"):
  // select it once and drop the request, so a later manual selection sticks.
  useEffect(() => {
    if (!triageFocus) return;
    select(triageFocus);
    setTab(triageFocus, agentKind);
    consumeTriageFocus();
  }, [triageFocus, select, setTab, consumeTriageFocus, agentKind]);

  // Vim-style queue navigation (j/k, ⌘I, ⌘O).
  // j/k must land you back on the queue, not scroll it behind an open session.
  useTriageKeyboard({
    ordered,
    activeId,
    detail,
    onSelect: select,
    onInvestigate: investigate,
  });

  const renderRow = (t: TriageTicket, manual = false) => (
    <QueueRow
      key={t.id}
      ticket={t}
      active={t.id === activeId}
      selectable={canInvestigate && eligible.has(t.id)}
      selected={!!selected[t.id]}
      investigating={hasAnyLiveProvider(t.id)}
      agentKinds={providersFor(t.id)}
      agentStates={activityByTicket.get(t.id) ?? []}
      manual={manual}
      manualDisabled={linearReadOnly || setSortOrder.isPending}
      dragging={dragState?.movedId === t.id}
      onManualDragStart={startManualDrag}
      onManualDragOver={dragManualOver}
      onManualDragEnd={finishManualDrag}
      onManualMove={moveManualWithKeyboard}
      onSelect={select}
      onToggleSelect={toggle}
      onHover={onHoverRow}
    />
  );

  const renderLanes = (lanes: TriageLanes) => (
    <>
      {lanes.investigations.length > 0 && (
        <div className="mb-2">
          <QueueLaneHeader label="Investigations" count={lanes.investigations.length} />
          {lanes.investigations.map((ticket) => renderRow(ticket))}
        </div>
      )}
      {lanes.queue.length > 0 && (
        <div className="mb-2">
          <QueueLaneHeader label="Queue" count={lanes.queue.length} />
          {lanes.queue.map((ticket) => renderRow(ticket, order === "manual"))}
        </div>
      )}
      {lanes.snoozed.length > 0 && (
        <div className="mb-2">
          <QueueLaneHeader label="Snoozed" count={lanes.snoozed.length} />
          {lanes.snoozed.map((ticket) => renderRow(ticket))}
        </div>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          className="flex flex-none flex-col border-r border-line bg-panel"
          style={{ width: QUEUE_WIDTH }}
        >
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
              <ChevronSelect
                value={order}
                onChange={(value) =>
                  setSetting.mutate({ scope: "app", key: TRIAGE_ORDER_KEY, value })
                }
                aria-label="Order triage queue"
                title={
                  order === "manual" && linearReadOnly
                    ? "Manual ordering is locked because Linear is read-only"
                    : "Order triage queue"
                }
                wrapperClassName="w-[124px] flex-none"
                className="h-[26px] w-full rounded-[var(--radius-sm)] border border-line-2 bg-input px-2 pr-7 text-[10.5px] text-fg-3"
              >
                {TRIAGE_ORDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </ChevronSelect>
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
            {loading ? (
              <QueueSkeleton />
            ) : ordered.length === 0 ? (
              <EmptyState className="py-8" title="Nothing in triage." />
            ) : grouped ? (
              renderedGroups.map(({ team, lanes }) => (
                <div key={team} className="mb-3">
                  <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                    {team}
                    <span className="text-muted-5">
                      {lanes.investigations.length + lanes.queue.length + lanes.snoozed.length}
                    </span>
                  </div>
                  <div className="border-l border-hairline pl-1.5">{renderLanes(lanes)}</div>
                </div>
              ))
            ) : (
              renderedGroups[0] && renderLanes(renderedGroups[0].lanes)
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
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-app">
          {loading ? (
            // The queue hasn't landed yet, so we don't know there's nothing to
            // triage — "All caught up" here would be a cheerful lie.
            <DiscussionSkeleton />
          ) : ordered.length === 0 ? (
            <AllCaughtUp goodCitizen={goodCitizen} teamWaiting={teamWaiting} onTriage={onTriage} />
          ) : !activeTicket ? (
            <TriageHome tickets={ordered} onSelect={select} onTriage={onTriage} />
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
      </div>
    </div>
  );
}
