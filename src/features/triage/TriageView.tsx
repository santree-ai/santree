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
import { useCallback, useEffect, useMemo } from "react";

import type { AgentKind, TriageTicket } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { DiscussionPane, DiscussionSkeleton } from "../../components/IssueDiscussion";
import { EmptyState } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import {
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_COMMAND_KEY,
  INVESTIGATE_MODEL_KEY,
  usePrefetchOnHover,
  useRefreshTriage,
  useRepos,
  useResolvedSetting,
  useTriageDetail,
  useTriageQueue,
  useTriageSchedule,
  useTriageSetState,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { useTerminals } from "../terminal/TerminalsContext";
import { DetailTabs } from "./DetailTabs";
import { useKeptPanes, useTabByTicket, useTriageKeyboard, useTriageSelection } from "./hooks";
import { InvestigatePane } from "./InvestigatePane";
import { IssueHeader } from "./IssueHeader";
import { QueueRow } from "./QueueRow";
import { ScheduleSection } from "./ScheduleSection";

/** How many recently-viewed discussion panes to keep mounted (hidden). */
const MAX_KEPT_PANES = 6;

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
  const navigate = useNavigate();
  const { data: schedules = [] } = useTriageSchedule(activeRepo);
  const { visible, teamWaiting, goodCitizen } = useTriageQueue(activeRepo);
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
  const repoPath = repos.find((r) => r.name === activeRepo)?.path ?? undefined;

  // The Triage Investigation action config for this repo (repo override, else
  // the app default): which agent runs it, which skill, and which model.
  const { data: investigateAgent } = useResolvedSetting(activeRepo, INVESTIGATE_AGENT_KEY);
  const { data: investigateCommand } = useResolvedSetting(activeRepo, INVESTIGATE_COMMAND_KEY);
  const { data: investigateModel } = useResolvedSetting(activeRepo, INVESTIGATE_MODEL_KEY);
  // Resolve the chosen agent to its executable from Settings → Agents.
  const agentKind = (investigateAgent as AgentKind | null) ?? "Claude";
  const agentExec = settings?.agents.find((a) => a.key === agentKind)?.exec ?? "";

  const { tabs: terminalTabs } = useTerminals();

  // Active issues first, snoozed sunk to the bottom (matching the CLI).
  const ordered = useMemo(
    () => [...visible].sort((a, b) => Number(!!a.snoozedUntil) - Number(!!b.snoozedUntil)),
    [visible],
  );
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

  // Header and body both key off `activeId`, so they switch together in one
  // render — never a new title over the previous ticket's content.
  const { data: detail } = useTriageDetail(activeRepo, activeId);
  const { refresh, fetching: refreshing } = useRefreshTriage(activeRepo, activeId);

  // Recently-viewed discussion panes stay mounted (hidden) so revisiting a
  // ticket is instant; new panes mount under a transition so the first heavy
  // render never blocks the click.
  const { keptPanes, detailFor } = useKeptPanes(detail, MAX_KEPT_PANES);

  // Per-ticket detail-tab memory (Discussion vs Investigation), so an open
  // investigation survives navigating away and back.
  const { tabFor, setTab } = useTabByTicket();
  const selectedTab = tabFor(activeId);
  const hasInvestigation =
    !!activeTicket &&
    terminalTabs.some((t) => t.source === "triage" && t.refId === activeTicket.id);
  const showInvestigation = hasInvestigation || selectedTab === "investigate";
  const investigate = useCallback(() => setTab(activeId, "investigate"), [setTab, activeId]);
  // When the investigate terminal exits, fall back to this ticket's discussion.
  const backToDiscussion = useCallback(() => setTab(activeId, "discussion"), [setTab, activeId]);

  // Redirect away if triage gets disabled while open.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/" });
  }, [triageEnabled, navigate]);

  // Vim-style queue navigation (j/k, ⌘I, ⌘O).
  useTriageKeyboard({ ordered, activeId, detail, onSelect: select, onInvestigate: investigate });

  const renderRow = (t: TriageTicket) => (
    <QueueRow
      key={t.id}
      ticket={t}
      active={t.id === activeId}
      onSelect={select}
      onHover={onHoverRow}
    />
  );

  return (
    <ViewChrome
      sidebar={
        <>
          <ScheduleSection schedules={schedules} />
          <div className="flex-1 overflow-y-auto p-2">
            {ordered.length === 0 ? (
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
          <SidebarFooter />
        </>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        {!activeTicket ? (
          <AllCaughtUp goodCitizen={goodCitizen} teamWaiting={teamWaiting} onTriage={onTriage} />
        ) : (
          <>
            {/* Header renders instantly from the queue row; richer fields
                (author, labels, status) fill in when the detail loads. */}
            <IssueHeader
              ticket={activeTicket}
              detail={detail?.id === activeTicket.id ? detail : undefined}
              onSetState={(stateId) => setState.mutate({ ticketId: activeTicket.id, stateId })}
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
                  <DiscussionPane detail={d} />
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
                ticketId={activeTicket.id}
                cwd={repoPath}
                command={investigateCommand ?? null}
                agentExec={agentExec}
                model={investigateModel ?? null}
                onExited={backToDiscussion}
              />
            )}
          </>
        )}
      </div>
    </ViewChrome>
  );
}
