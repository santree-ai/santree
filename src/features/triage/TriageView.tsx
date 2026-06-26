/**
 * The Triage tab. The left rail is the untriaged queue (snoozed issues greyed
 * and sunk to the bottom) plus the team on-call schedule. The main pane renders
 * the selected Linear issue: its description (markdown + images) and comment
 * thread. "Investigate" opens a real terminal in the repo for now (an
 * auto-invoked investigate skill comes later).
 */

import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CSSProperties } from "react";
import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentKind,
  TriageComment,
  TriageDetail,
  TriageSchedule,
  TriageTicket,
} from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { CalendarIcon, LinearLogo, RefreshIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Badge, Skeleton } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import {
  INVESTIGATE_AGENT_KEY,
  INVESTIGATE_COMMAND_KEY,
  INVESTIGATE_MODEL_KEY,
  useRefreshTriage,
  useRepos,
  useResolvedSetting,
  useTriageDetail,
  useTriageDetailPrefetch,
  useTriageSchedule,
  useTriageSetState,
  useTriageTickets,
} from "../../lib/queries";
import { inEditable } from "../../lib/useKeyboardShortcuts";
import { useApp } from "../../state/AppContext";
import { priorityColor } from "../../theme/colors";
import { useTerminals } from "../terminal/TerminalsContext";

export function TriageView() {
  const { triageEnabled, activeRepo, settings } = useApp();
  const navigate = useNavigate();
  const { data: tickets = [] } = useTriageTickets(activeRepo);
  const { data: schedules = [] } = useTriageSchedule(activeRepo);
  const { data: repos = [] } = useRepos();
  const prefetchDetail = useTriageDetailPrefetch();
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The selected detail tab, remembered per ticket so switching tickets and
  // coming back restores whichever tab you were on (Discussion or Investigation).
  // Tickets default to Discussion until you open their investigation.
  const [tabByTicket, setTabByTicket] = useState<Record<string, DetailTab>>({});

  // Active issues first, snoozed sunk to the bottom (matching the CLI).
  const ordered = useMemo(
    () => [...tickets].sort((a, b) => Number(!!a.snoozedUntil) - Number(!!b.snoozedUntil)),
    [tickets],
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

  // Keep a valid selection as the queue loads / changes.
  const activeId =
    selectedId && tickets.some((t) => t.id === selectedId) ? selectedId : (ordered[0]?.id ?? null);
  const activeTicket = tickets.find((t) => t.id === activeId) ?? null;

  // Header and body both key off `activeId`, so they switch together in one
  // render — never a new title over the previous ticket's content.
  const { data: detail } = useTriageDetail(activeRepo, activeId);
  const { refresh, fetching: refreshing } = useRefreshTriage(activeRepo, activeId);

  // Click latency comes from painting the heavy body in the same commit as the
  // row highlight. `deferredId` lags `activeId`, so we only reveal the body once
  // it has caught up — the highlight + header commit first (instant click), and
  // the body's paint lands in the deferred commit. While they differ we show a
  // skeleton, never the previous ticket's content.
  const deferredId = useDeferredValue(activeId);
  const bodyReady = deferredId === activeId;

  // Discussion bodies are expensive to render (markdown + inline base64 images),
  // so we keep recently-viewed panes mounted and just toggle visibility. A pane
  // is added at *transition* priority, so its first heavy render never blocks the
  // click. Revisiting a kept pane is instant (no re-parse). `detailsRef` snapshots
  // each ticket's detail so inactive panes keep rendering their own content.
  const MAX_KEPT_PANES = 6;
  const detailsRef = useRef(new Map<string, TriageDetail>());
  const [keptPanes, setKeptPanes] = useState<string[]>([]);
  useEffect(() => {
    if (!detail) return;
    detailsRef.current.set(detail.id, detail);
    startTransition(() => {
      setKeptPanes((cur) =>
        cur.includes(detail.id) ? cur : [...cur, detail.id].slice(-MAX_KEPT_PANES),
      );
    });
  }, [detail]);

  // Redirect away if triage gets disabled while open.
  useEffect(() => {
    if (!triageEnabled) navigate({ to: "/" });
  }, [triageEnabled, navigate]);

  // The tab for the active ticket (its remembered choice, else Discussion). An
  // "Investigation" tab/terminal exists when a triage session is live for it.
  const selectedTab: DetailTab = (activeId ? tabByTicket[activeId] : undefined) ?? "discussion";
  const hasInvestigation =
    !!activeTicket &&
    terminalTabs.some((t) => t.source === "triage" && t.refId === activeTicket.id);
  const showInvestigation = hasInvestigation || selectedTab === "investigate";
  const selectTab = useCallback(
    (tab: DetailTab) => {
      if (activeId) setTabByTicket((m) => ({ ...m, [activeId]: tab }));
    },
    [activeId],
  );
  // When the investigate terminal exits, fall back to this ticket's discussion.
  const backToDiscussion = useCallback(() => {
    if (activeId) setTabByTicket((m) => ({ ...m, [activeId]: "discussion" }));
  }, [activeId]);

  // Selecting a ticket only changes which ticket is active; each ticket keeps
  // its own tab choice (so an open Investigation survives navigating away).
  const onSelectRow = useCallback((id: string) => setSelectedId(id), []);
  const onHoverRow = useCallback(
    (id: string) => prefetchDetail(activeRepo, id),
    [prefetchDetail, activeRepo],
  );

  // Vim-style queue navigation: j / k step through the queue, ⌘I investigates the
  // current issue, ⌘O opens it in Linear. Skipped while focus is in a field (incl. the embedded terminal,
  // whose xterm input is a textarea), so these keys never steal from the agent.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (inEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.altKey && (e.key === "i" || e.key === "I")) {
        if (!activeId) return;
        e.preventDefault();
        selectTab("investigate");
        return;
      }
      if (mod && !e.altKey && (e.key === "o" || e.key === "O")) {
        // Open the current issue in Linear (same as the "Open Issue" button);
        // the URL only exists once the detail has loaded.
        if (!detail) return;
        e.preventDefault();
        openUrl(detail.url);
        return;
      }
      if (mod || e.altKey) return;

      if (e.key === "j" || e.key === "k") {
        if (ordered.length === 0) return;
        e.preventDefault();
        const idx = ordered.findIndex((t) => t.id === activeId);
        const delta = e.key === "j" ? 1 : -1;
        // Clamp at the ends; with no selection, j picks the first / k the last.
        const nextIdx =
          idx === -1
            ? delta === 1
              ? 0
              : ordered.length - 1
            : Math.min(Math.max(idx + delta, 0), ordered.length - 1);
        const next = ordered[nextIdx];
        if (!next || next.id === activeId) return;
        setSelectedId(next.id);
        // Keep the newly-selected row visible in the scrollable queue.
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-ticket-id="${CSS.escape(next.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, activeId, detail, selectTab]);

  const renderRow = (t: TriageTicket) => (
    <QueueRow
      key={t.id}
      ticket={t}
      active={t.id === activeId}
      onSelect={onSelectRow}
      onHover={onHoverRow}
    />
  );

  return (
    <ViewChrome
      sidebar={
        <>
          <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
            <span className="text-[12px] font-semibold text-fg-2">Triage queue</span>
            <span className="rounded-[5px] border border-status-red/30 bg-status-red/10 px-1.5 py-px font-mono text-[10.5px] text-status-red">
              {tickets.length}
            </span>
          </div>
          <ScheduleSection schedules={schedules} />
          <div className="flex-1 overflow-y-auto p-2">
            {ordered.length === 0 ? (
              <div className="px-3 py-8 text-center text-[11.5px] leading-relaxed text-muted-3">
                Nothing in triage. 🎉
              </div>
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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="text-[15px] font-medium text-fg-2">Triage is clear</div>
            <div className="max-w-[320px] text-[12px] text-muted-3">
              No issues are waiting in triage for this workspace right now.
            </div>
          </div>
        ) : (
          <>
            {/* Header renders instantly from the queue row; richer fields
                (author, labels, status) fill in when the detail loads. */}
            <IssueHeader
              ticket={activeTicket}
              detail={detail?.id === activeTicket.id ? detail : undefined}
              onSetState={(stateId) => setState.mutate({ ticketId: activeTicket.id, stateId })}
              setting={setState.isPending}
              investigating={selectedTab === "investigate"}
              onInvestigate={() => selectTab("investigate")}
              onRefresh={refresh}
              refreshing={refreshing}
            />
            {/* The tab bar appears only once an investigation is started. */}
            {showInvestigation && <DetailTabs tab={selectedTab} onTab={selectTab} />}
            {/* Kept discussion panes stay mounted (hidden) so revisiting a ticket
                is instant. Only revealed once `deferredId` catches up, keeping the
                heavy paint out of the click's commit. */}
            {keptPanes.map((id) => {
              const d = id === activeId ? detail : detailsRef.current.get(id);
              if (!d) return null;
              const visible = id === activeId && bodyReady && selectedTab === "discussion";
              return (
                <div key={id} className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                  <DiscussionPane detail={d} />
                </div>
              );
            })}
            {/* Skeleton while the body catches up (deferred) or on a first load. */}
            {selectedTab === "discussion" &&
              (!bodyReady || !keptPanes.includes(activeTicket.id)) && <DiscussionSkeleton />}
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

// ── Sidebar ────────────────────────────────────────────────────────────────

const QueueRow = memo(function QueueRow({
  ticket,
  active,
  onSelect,
  onHover,
}: {
  ticket: TriageTicket;
  active: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
}) {
  const snoozed = !!ticket.snoozedUntil;
  const style: CSSProperties = active
    ? {
        border: "1px solid color-mix(in srgb, var(--accent) 33%, transparent)",
        background: "color-mix(in srgb, var(--accent) 5%, transparent)",
      }
    : { border: "1px solid transparent", background: "transparent" };
  const pc = snoozed ? "var(--color-muted-4)" : priorityColor[ticket.priority];

  return (
    <button
      type="button"
      data-ticket-id={ticket.id}
      onClick={() => onSelect(ticket.id)}
      onMouseEnter={() => onHover(ticket.id)}
      className="mb-[5px] w-full min-w-0 cursor-pointer overflow-hidden rounded-[9px] px-[11px] py-[11px] text-left transition-colors hover:bg-hover"
      style={{ ...style, opacity: snoozed ? 0.55 : 1 }}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex-none font-mono text-[10.5px] text-muted-2">{ticket.id}</span>
        <span
          className="flex-none rounded px-1.5 py-px font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
          style={{ color: pc, background: `${pc}15`, border: `1px solid ${pc}40` }}
        >
          {ticket.priority}
        </span>
        {snoozed ? (
          <span className="ml-auto flex flex-none items-center gap-1 font-mono text-[10px] text-muted-4">
            💤 {ticket.snoozedUntil}
          </span>
        ) : (
          <span className="ml-auto flex-none font-mono text-[10px] text-muted-4">{ticket.age}</span>
        )}
      </div>
      <div
        className="line-clamp-2 text-[12.5px] leading-[1.35] text-fg-3"
        style={{ overflowWrap: "anywhere" }}
      >
        {ticket.title}
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-muted-4">
        <span className="min-w-0 truncate">{ticket.meta}</span>
        {ticket.sla && !snoozed && (
          <span className="ml-auto flex-none font-mono text-status-red/80">{ticket.sla}</span>
        )}
      </div>
    </button>
  );
});

/** All of the viewer's triage on-call rotations (one per team). */
function ScheduleSection({ schedules }: { schedules: TriageSchedule[] }) {
  if (schedules.length === 0) return null;
  return (
    <div className="flex-none space-y-1.5 border-b border-hairline px-[13px] py-2.5">
      {schedules.map((s) => (
        <ScheduleStrip key={`${s.team}-${s.scheduleName}`} schedule={s} />
      ))}
    </div>
  );
}

function ScheduleStrip({ schedule }: { schedule: TriageSchedule }) {
  const [open, setOpen] = useState(false);
  const { accent } = useApp();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-line-2 bg-input px-2.5 py-2 text-left transition-colors hover:border-line-strong"
      >
        <CalendarIcon size={14} className="flex-none text-muted-3" />
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] tracking-[.06em] text-muted-4 uppercase">
            {schedule.scheduleName}
          </div>
          <div className="truncate text-[11.5px] text-fg-3">
            On triage: <span className="text-fg-2">{schedule.currentName ?? "—"}</span>
          </div>
        </div>
        {schedule.currentIsMe && <Badge color={accent}>YOU</Badge>}
        <span className="text-[9px] text-muted-3">▾</span>
      </button>

      {open && (
        <div className="mt-1.5 rounded-lg border border-line-2 bg-input p-1.5">
          {(schedule.shifts ?? []).map((s) => (
            <div
              key={`${s.name}-${s.range}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              style={
                s.isCurrent
                  ? { background: "color-mix(in srgb, var(--accent) 8%, transparent)" }
                  : undefined
              }
            >
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: s.isCurrent ? accent : "var(--color-dot)" }}
              />
              <span
                className="flex-1 text-[11.5px]"
                style={{ color: s.isMe ? accent : "var(--color-fg-2)" }}
              >
                {s.name}
                {s.isMe && !s.isCurrent && " (you)"}
              </span>
              <span className="font-mono text-[10px] text-muted-4">{s.range}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Issue detail (Discussion) ────────────────────────────────────────────────

/**
 * The workflow-state picker that replaces the old "Promote" button. Changing the
 * state to a non-triage state (Backlog/Todo/…) moves the issue out of the triage
 * queue — i.e. "promotes" it. Shows a static badge until the detail (and thus the
 * team's states) loads.
 */
function StatusPicker({
  detail,
  onSetState,
  setting,
}: {
  detail?: TriageDetail;
  onSetState: (stateId: string) => void;
  setting: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!detail) {
    return (
      <span className="rounded border border-line-2 bg-input px-[7px] py-[1.5px] font-mono text-[9px] text-muted-2">
        Triage
      </span>
    );
  }

  const current = detail.states.find((s) => s.id === detail.stateId);
  const label = current?.name ?? detail.state;
  const color = current?.color ?? "var(--color-muted-3)";
  const disabled = setting || detail.states.length === 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="flex cursor-pointer items-center gap-1.5 rounded border border-line-2 bg-input px-[7px] py-[2.5px] text-[10.5px] text-fg-2 hover:border-line-strong disabled:cursor-default disabled:opacity-60"
      >
        <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: color }} />
        {setting ? "Saving…" : label}
        <span className="text-[8px] text-muted-3">▾</span>
      </button>

      {open && (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute top-full left-0 z-50 mt-1 min-w-[170px] rounded-lg border border-line-2 bg-popover p-1 shadow-xl">
            {detail.states.map((s) => {
              const isCurrent = s.id === detail.stateId;
              return (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => {
                    setOpen(false);
                    if (!isCurrent) onSetState(s.id);
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg-3 hover:bg-hover-2"
                >
                  <span
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="flex-1">{s.name}</span>
                  {isCurrent && <span className="text-[10px] text-[color:var(--accent)]">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** The AI "spark" glyph for the Investigate button — a big 4-point star + a small one. */
function InvestigateIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2.2c.3 2.6 1 4.5 2.2 5.6 1.1 1.2 3 1.9 5.6 2.2-2.6.3-4.5 1-5.6 2.2-1.2 1.1-1.9 3-2.2 5.6-.3-2.6-1-4.5-2.2-5.6-1.1-1.2-3-1.9-5.6-2.2 2.6-.3 4.5-1 5.6-2.2 1.2-1.1 1.9-3 2.2-5.6Z" />
      <path d="M18.5 14.5c.15 1.3.5 2.25 1.1 2.8.55.6 1.5.95 2.8 1.1-1.3.15-2.25.5-2.8 1.1-.6.55-.95 1.5-1.1 2.8-.15-1.3-.5-2.25-1.1-2.8-.55-.6-1.5-.95-2.8-1.1 1.3-.15 2.25-.5 2.8-1.1.6-.55.95-1.5 1.1-2.8Z" />
    </svg>
  );
}

function IssueHeader({
  ticket,
  detail,
  onSetState,
  setting,
  investigating,
  onInvestigate,
  onRefresh,
  refreshing,
}: {
  ticket: TriageTicket;
  detail?: TriageDetail;
  onSetState: (stateId: string) => void;
  setting: boolean;
  investigating: boolean;
  onInvestigate: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const pc = priorityColor[ticket.priority];
  return (
    <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <span className="font-mono text-[11.5px] text-muted-2">{ticket.id}</span>
        <span
          className="rounded px-[7px] py-[1.5px] font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
          style={{ color: pc, background: `${pc}15`, border: `1px solid ${pc}40` }}
        >
          {ticket.priority}
        </span>
        <StatusPicker detail={detail} onSetState={onSetState} setting={setting} />
        {ticket.sla && (
          <span className="font-mono text-[10.5px] text-status-red/90">{ticket.sla}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh this issue from Linear"
            aria-label="Refresh"
            className="flex h-[27px] w-[27px] cursor-pointer items-center justify-center rounded-md border border-line-2 bg-input text-muted-2 hover:text-fg-2 disabled:cursor-default"
          >
            <RefreshIcon size={13} className={refreshing ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={() => detail && openUrl(detail.url)}
            disabled={!detail}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[11px] text-muted-2 hover:text-fg-2 disabled:cursor-default disabled:opacity-40"
          >
            <LinearLogo size={12} className="text-[#5e6ad2]" />
            Open Issue
          </button>
          <button
            type="button"
            onClick={onInvestigate}
            title="Open a terminal to investigate this issue"
            className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors"
            style={{
              color: "var(--accent)",
              borderColor: investigating
                ? "color-mix(in srgb, var(--accent) 55%, transparent)"
                : "color-mix(in srgb, var(--accent) 30%, transparent)",
              background: investigating
                ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                : "color-mix(in srgb, var(--accent) 11%, transparent)",
            }}
          >
            <InvestigateIcon size={13} />
            Investigate
          </button>
        </div>
      </div>
      <div className="mb-2 text-[17px] leading-[1.3] font-semibold text-fg-bright">
        {ticket.title}
      </div>
      <div className="flex min-h-[17px] flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px] text-muted-3">
        {detail ? (
          <>
            <span className="flex items-center gap-1.5">
              <Avatar name={detail.author} src={detail.authorAvatarUrl} size={17} />
              {detail.author}
            </span>
            <span className="text-muted-5">·</span>
            <span>{detail.created}</span>
            {detail.project && (
              <>
                <span className="text-muted-5">·</span>
                <span>{detail.project}</span>
              </>
            )}
            {detail.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[10px] text-muted-2"
              >
                {l}
              </span>
            ))}
          </>
        ) : (
          // Author/labels arrive with the detail — placeholder until then.
          <>
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3.5 w-14 rounded" />
            <Skeleton className="h-3.5 w-20 rounded" />
          </>
        )}
      </div>
      {ticket.snoozedUntil && (
        <div className="mt-2.5 flex items-center gap-2 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[11px] text-muted-2">
          💤 Snoozed until {ticket.snoozedUntil} — sits at the bottom of the queue until then.
        </div>
      )}
    </div>
  );
}

function countComments(comments: TriageComment[]): number {
  return comments.reduce((n, c) => n + 1 + countComments(c.children), 0);
}

function CommentHead({ comment, size }: { comment: TriageComment; size: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Avatar name={comment.author} src={comment.avatarUrl} size={size} />
      <span className="text-[11.5px] font-medium text-fg-2">{comment.author}</span>
      <span className="font-mono text-[10px] text-muted-4">{comment.created}</span>
    </div>
  );
}

function CommentItem({ comment }: { comment: TriageComment }) {
  return (
    <div className="rounded-[10px] border border-hairline bg-panel px-3.5 py-3">
      <CommentHead comment={comment} size={22} />
      <Markdown>{comment.body}</Markdown>

      {comment.children.length > 0 && (
        // Threaded replies — indented under a connector rail, no separate card.
        <div className="mt-3.5 space-y-3.5 border-l-2 border-line-2 pl-3.5">
          {comment.children.map((child, i) => (
            <div key={`${child.author}-${i}`}>
              <CommentHead comment={child} size={18} />
              <Markdown>{child.body}</Markdown>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Placeholder shown while a freshly-selected issue's detail loads. */
function DiscussionSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto px-5 py-[18px]">
      <div className="space-y-2.5">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="mt-4 h-28 w-full rounded-lg" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <div className="mt-7 space-y-3.5">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-[10px] border border-hairline bg-panel px-3.5 py-3">
            <div className="mb-2 flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-1.5 h-3 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Memoized on `detail` so toggling a kept pane's visibility (or reordering the
// kept list) never re-parses its markdown — only genuinely new detail data does.
const DiscussionPane = memo(function DiscussionPane({ detail }: { detail: TriageDetail }) {
  const total = countComments(detail.comments);
  return (
    <div className="flex-1 overflow-y-auto px-5 py-[18px]">
      <Markdown>{detail.description}</Markdown>

      {total > 0 && (
        <div className="mt-6">
          <div className="mb-3 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
            {total} {total === 1 ? "comment" : "comments"}
          </div>
          <div className="space-y-3.5">
            {detail.comments.map((c, i) => (
              <CommentItem key={`${c.author}-${i}`} comment={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

// ── Investigate ──────────────────────────────────────────────────────────────

type DetailTab = "discussion" | "investigate";

const DETAIL_TABS: [DetailTab, string][] = [
  // Discussion first; the Investigation tab only renders once a session is live.
  ["discussion", "Discussion"],
  ["investigate", "Investigation"],
];

function DetailTabs({ tab, onTab }: { tab: DetailTab; onTab: (t: DetailTab) => void }) {
  const { accent } = useApp();
  return (
    <div className="flex flex-none items-stretch gap-1 border-b border-hairline px-5">
      {DETAIL_TABS.map(([key, label]) => {
        const active = tab === key;
        return (
          <button
            type="button"
            key={key}
            onClick={() => onTab(key)}
            className="cursor-pointer px-2 py-2 text-[12px]"
            style={
              active
                ? {
                    color: "var(--color-fg-bright)",
                    fontWeight: 500,
                    boxShadow: `inset 0 -2px 0 ${accent}`,
                  }
                : { color: "#7c7c85" }
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The Investigate tab. For now it hosts a real terminal scoped to the repo (a
 * Claude investigation will replace it later — see COMPLIANCE.md). The terminal
 * is a *global* session (so it also appears in the Terminal tab, grouped under
 * "Triage"); we render it here by registering this pane as the embed host — the
 * persistent TerminalLayer positions the live session over it.
 */
/** Single-quote a string for a POSIX shell command line. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function InvestigatePane({
  ticketId,
  cwd,
  command,
  agentExec,
  model,
  onExited,
}: {
  ticketId: string;
  cwd?: string;
  /** Configured investigate skill name (a Claude slash-command), or null. */
  command: string | null;
  /** The chosen agent's executable from settings; falls back to PATH when blank. */
  agentExec: string;
  /** Model override for the run, or null to use the agent's default. */
  model: string | null;
  onExited: () => void;
}) {
  const { tabs, ensure, setEmbed } = useTerminals();
  const hostRef = useRef<HTMLDivElement>(null);
  const keyRef = useRef<string | null>(null);
  const seenRef = useRef(false);

  // A layout effect (not passive) so the embed is set/torn down synchronously
  // with the DOM commit, before paint. Otherwise React can defer the passive
  // cleanup behind the concurrent (deferred-value) re-render that's waiting on
  // the next ticket's fetch, leaving the terminal painted over the new ticket
  // for ~1s after switching away.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // When a skill is configured, launch the configured agent executable under a
    // login shell so it + node resolve on PATH (like a normal terminal); `exec`
    // replaces the shell so quitting the agent closes the tab. Mirrors the CLI's
    // `claude [--model M] '/<cmd> <ticket>'`. With nothing configured, a plain shell.
    const exec = agentExec.trim() || "claude";
    const modelFlag = model ? `--model ${shellQuote(model)} ` : "";
    const seed = command
      ? `exec ${shellQuote(exec)} ${modelFlag}${shellQuote(`/${command} ${ticketId}`)}`
      : undefined;
    // Reuse this ticket's session if it's still alive, else spawn a fresh one.
    const key = ensure({ title: ticketId, cwd, source: "triage", refId: ticketId, seed });
    keyRef.current = key;
    seenRef.current = false;
    // Pass the host's current rect so the layer is sized right on first paint
    // (the terminal opens at the correct size instead of the full content area).
    const r = host.getBoundingClientRect();
    setEmbed({
      host,
      key,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    });
    return () => setEmbed(null);
  }, [ticketId, cwd, command, agentExec, model, ensure, setEmbed]);

  // When our session's process exits, its tab is removed — drop back to the
  // discussion (re-opening Investigate then spawns a brand-new terminal). The
  // `seen` latch avoids firing during the mount tick before the tab registers.
  useEffect(() => {
    const key = keyRef.current;
    if (!key) return;
    if (tabs.some((t) => t.key === key)) {
      seenRef.current = true;
    } else if (seenRef.current) {
      keyRef.current = null;
      seenRef.current = false;
      onExited();
    }
  }, [tabs, onExited]);

  return (
    <div className="min-h-0 flex-1">
      {/* The TerminalLayer overlays this host with the ticket's live session. */}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
