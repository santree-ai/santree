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
import { BranchIcon, ClaudeSparkIcon } from "../../components/icons";
import { Button, EmptyState, Segmented, Skeleton } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import {
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_EFFORT_KEY,
  INVESTIGATE_MODEL_KEY,
  INVESTIGATE_REMOTE_CONTROL_KEY,
  TRIAGE_GOOD_CITIZEN_KEY,
  useBaseWorktree,
  useLinearReadOnly,
  usePrefetchOnHover,
  useRefreshTriage,
  useRepos,
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
import { QueueRow } from "./QueueRow";
import { RepoSessionPane } from "./RepoSessionPane";
import { ScheduleSection } from "./ScheduleSection";

/**
 * The repo-session row at the top of the rail — Triage's answer to the Trees
 * rail's `master` entry. Selecting it opens a Claude session on the base
 * checkout that isn't attached to any ticket.
 *
 * Shaped like Trees' `BaseEntry` on purpose (branch icon, branch name, the row's
 * own action as a stretched button) so the two read as the same idea in two
 * views; the spark marks it as the one row here that opens an agent rather than
 * a ticket.
 */
function RepoSessionEntry({
  branch,
  active,
  onSelect,
}: {
  branch: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className="relative mb-1 flex items-center gap-2 rounded-[9px] px-[11px] py-2 text-[12px] hover:bg-hover"
      style={{
        background: active ? alpha(8) : "transparent",
        color: active ? "var(--accent)" : "var(--color-muted-2)",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Ask Claude on ${branch}`}
        title={`Ask Claude on ${branch} — a session not tied to any ticket`}
        className="absolute inset-0 cursor-pointer rounded-[9px]"
      />
      <BranchIcon size={13} className="flex-none" />
      <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
      <ClaudeSparkIcon size={12} className="relative flex-none" />
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
        // We know who's holding the fort — wave their face around for a nudge.
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
  const { triageEnabled, activeRepo, settings } = useApp();
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
  const { data: investigateModel } = useResolvedSetting(activeRepo, INVESTIGATE_MODEL_KEY);
  const { data: investigateEffort } = useResolvedSetting(activeRepo, INVESTIGATE_EFFORT_KEY);
  // Resolve the chosen agent to its executable from Settings → Agents.
  const agentKind = (investigateAgent as AgentKind | null) ?? "Claude";
  const agentExec = settings?.agents?.find((a) => a.key === agentKind)?.exec ?? "";

  const { tabs: terminalTabs } = useTerminals();

  // Tickets whose investigation terminal is live right now.
  const liveInvestigations = useMemo(
    () =>
      new Set(
        terminalTabs
          .filter((t) => t.source === "triage" && t.refId !== undefined)
          .map((t) => t.refId as string),
      ),
    [terminalTabs],
  );
  // Tickets with a stored session from a past investigation (persists across app
  // restarts) — they get the tab + resume affordance even when not live.
  const { data: startedIds = [] } = useStartedInvestigations(activeRepo);
  const startedInvestigations = useMemo(() => new Set(startedIds), [startedIds]);

  // Investigations float above the backlog — a running agent first, then a
  // resumable one — because that's in-flight work you're likely to return to,
  // regardless of where SLA puts it. Snoozed still sinks to the bottom (matching
  // the CLI). `sort` is stable, so SLA order holds within each rank.
  const rank = useCallback(
    (t: TriageTicket) => {
      if (t.snoozedUntilMs != null) return 3;
      if (liveInvestigations.has(t.id)) return 0;
      if (startedInvestigations.has(t.id)) return 1;
      return 2;
    },
    [liveInvestigations, startedInvestigations],
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
  const { data: baseWorktree } = useBaseWorktree(activeRepo);
  const selectTicket = useCallback(
    (id: string) => {
      setRepoSessionOpen(false);
      select(id);
    },
    [select],
  );

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
        .filter((t) => t.snoozedUntilMs == null && !liveInvestigations.has(t.id))
        .map((t) => t.id),
    [ordered, liveInvestigations],
  );
  // Rows test membership on every render — a Set keeps that off the O(n²) path.
  const eligible = useMemo(() => new Set(eligibleIds), [eligibleIds]);
  const { selected, toggle, clear, selectAll } = useInvestigateSelection(eligibleIds);
  const selectedIds = useMemo(
    () => eligibleIds.filter((id) => selected[id]),
    [eligibleIds, selected],
  );
  const allEligibleSelected = eligibleIds.length > 0 && eligibleIds.every((id) => selected[id]);
  const { data: remoteControlSetting } = useResolvedSetting(
    activeRepo,
    INVESTIGATE_REMOTE_CONTROL_KEY,
  );
  const batchInvestigate = useBatchInvestigate({
    repo: activeRepo,
    cwd: repoPath,
    agentExec,
    model: investigateModel ?? null,
    effort: investigateEffort ?? null,
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
  const hasInvestigation =
    !!activeTicket &&
    terminalTabs.some((t) => t.source === "triage" && t.refId === activeTicket.id);
  // The active ticket has a stored (resumable) session from a past investigation.
  const activeHasStarted = !!activeTicket && startedInvestigations.has(activeTicket.id);
  // Show the Investigation tab when it's live, has a resumable stored session, or
  // the user is actively on it — so past investigations surface a tab + resume.
  const showInvestigation = hasInvestigation || activeHasStarted || selectedTab === "investigate";
  const investigate = useCallback(() => setTab(activeId, "investigate"), [setTab, activeId]);
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
    setTab(triageFocus, "investigate");
    consumeTriageFocus();
  }, [triageFocus, selectTicket, setTab, consumeTriageFocus]);

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
      investigating={liveInvestigations.has(t.id)}
      started={startedInvestigations.has(t.id)}
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
                branch={baseWorktree.branch}
                active={repoSessionOpen}
                onSelect={() => setRepoSessionOpen(true)}
              />
            )}
            {loading ? (
              <QueueSkeleton />
            ) : ordered.length === 0 ? (
              <EmptyState className="py-8" title="Nothing in triage. 🎉" />
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
          <RepoSessionPane
            repo={activeRepo}
            branch={baseWorktree.branch}
            cwd={repoPath}
            agentExec={agentExec}
            model={investigateModel ?? null}
            effort={investigateEffort ?? null}
          />
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
              investigating={selectedTab === "investigate"}
              onInvestigate={investigate}
              onRefresh={refresh}
              refreshing={refreshing}
            />
            {/* The tab bar appears only once an investigation is started. */}
            {showInvestigation && (
              <DetailTabs tab={selectedTab} onTab={(t) => setTab(activeId, t)} />
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
            {selectedTab === "investigate" && (
              <InvestigatePane
                key={activeTicket.id}
                repo={activeRepo}
                ticketId={activeTicket.id}
                cwd={repoPath}
                agentExec={agentExec}
                model={investigateModel ?? null}
                effort={investigateEffort ?? null}
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
