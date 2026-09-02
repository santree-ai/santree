/**
 * The sidebar's Triage section: who is on rotation, then the queue, then what is
 * snoozed — each ticket a row with its investigations underneath.
 *
 * Triage used to be a destination with a rail of its own. The rail listed the
 * same tickets this section does, one click away from a permanent sidebar that
 * could have shown them all along — so the queue moved here, and `/triage` is
 * now only the workspace for the ticket you picked (`/triage?ticket=`).
 *
 * It speaks the tree's own vocabulary: the header is the PROJECTS register, the
 * Snoozed lane is a `.tree-band` container (it folds, it opens nothing), the
 * rotation is one row that opens its schedule in a dialog, and every ticket is
 * a `.tree-card` — a destination, lit while the workspace shows it, with the
 * ticket's own menu on a right-click (`TriageTicketMenu`). Selection follows
 * the route and nothing else, the same rule the project tree's worktree rows
 * follow.
 *
 * It scrolls with the sidebar, not inside it: the queue is a section of the
 * rail like the projects under it, and folding the section is how you stop
 * seeing it. It used to cap itself at 40vh behind a scrollbar of its own, which
 * read as a widget dropped into the sidebar rather than a part of it.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import type { TriageSchedule, TriageTicket } from "../../bindings";
import { agentKey } from "../../features/agents/registry";
import { useOpenAgent } from "../../features/agents/useOpenAgent";
import {
  TRIAGE_GOOD_CITIZEN_KEY,
  usePrefetchOnHover,
  useSetSetting,
  useTriageOrgRepo,
  useTriageQueue,
  useTriageSchedule,
} from "../../lib/queries";
import { formatShiftRange, formatSnoozeLabel } from "../../lib/relativeTime";
import { usePersistedState } from "../../lib/usePersistedState";
import { useApp } from "../../state/AppContext";
import { Avatar } from "../Avatar";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LinearLogo, SnoozeIcon } from "../icons";
import { MarkdownTitle } from "../Markdown";
import { Dropdown, MENU_ITEM, Skeleton } from "../primitives";
import { SlaSignal } from "../RelativeTime";
import { BAND_LABEL_X, CARD_GLYPH, CARD_INSET, CARD_LABEL_X, PriorityBars } from "../WorkSignals";
import { AgentRow } from "./AgentRow";
import { RotationDialog } from "./RotationDialog";
import { TriageTicketMenu } from "./TriageTicketMenu";
import { type AgentNode, useTicketAgents } from "./useProjectTree";

/** The section's own fold, and the Snoozed band inside it. Each holds "not the
 *  default" — open, closed — so neither needs seeding. */
const COLLAPSED_KEY = "santree.shell.triage.collapsed";
const SNOOZED_OPEN_KEY = "santree.shell.triage.snoozedOpen";

/** One rotation's identity — the key its row and its dialog agree on. */
const rotationKey = (schedule: TriageSchedule) => `${schedule.team}-${schedule.scheduleName}`;

/** Where the section's rows hang from: the header label's own column (`px-4`),
 *  the same rule the Projects label and its repo headers follow. */
const SECTION_GUTTER = 16;

/** A band heading brings its own `px-2`, so its wrapper makes up the difference
 *  and the chevron lands in the label column. */
const BAND_GUTTER = SECTION_GUTTER - 8;

/** Rows under a band hang from the band's label, not from its chevron — or the
 *  row reads as the band's sibling. */
const BAND_ROW_GUTTER = BAND_GUTTER + BAND_LABEL_X;

/** A ticket with no sessions gets the same array every render, so the row is
 *  not re-rendered for a fresh `[]`. */
const NO_AGENTS: AgentNode[] = [];

export function TriageSection() {
  const { triageEnabled } = useApp();
  const navigate = useNavigate();
  // The queue is read from the triage org's repo, which the workspace resolves
  // through the same hook, so the two can never show different queues. Two
  // Linear calls ride on it, so while the section isn't drawn the *repo* is
  // blanked — never the hook call, which has to run on every render.
  const orgRepo = useTriageOrgRepo();
  const repo = triageEnabled ? orgRepo : "";
  const { active, snoozed, goodCitizen, loading } = useTriageQueue(repo);
  const { data: schedules = [] } = useTriageSchedule(repo);
  const setSetting = useSetSetting();
  const onHover = usePrefetchOnHover(repo);
  const { agentsByTicket, markSeen } = useTicketAgents();
  const openAgent = useOpenAgent();
  const [collapsed, setCollapsed] = usePersistedState(COLLAPSED_KEY, false);
  // The rotation whose schedule is open in the dialog, by key. View state, not
  // persisted: a dialog that reopened itself on relaunch would be a surprise.
  const [rotationFor, setRotationFor] = useState<string | null>(null);
  const [snoozedOpen, setSnoozedOpen] = usePersistedState(SNOOZED_OPEN_KEY, false);
  // The ticket the workspace has open — the rail's one selection, read off the
  // route so it can't disagree with what the content area shows. A plain string,
  // so an unrelated navigation doesn't re-render the section on a fresh identity.
  const openTicket = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith("/triage")
        ? ((s.location.search as { ticket?: string }).ticket ?? null)
        : null,
  });

  const select = useCallback(
    (id: string) => navigate({ to: "/triage", search: { ticket: id } }),
    [navigate],
  );
  const openAgentRow = useCallback(
    (agent: AgentNode) => {
      // Acknowledge before navigating, exactly as the project tree does.
      markSeen(agent.entry);
      openAgent(agent.entry);
    },
    [markSeen, openAgent],
  );
  // The Mine/All switch *is* the "be a good citizen" setting — All widens to the
  // whole team inbox (issues not assigned to you included).
  const setGoodCitizen = (next: boolean) =>
    setSetting.mutate({ scope: "app", key: TRIAGE_GOOD_CITIZEN_KEY, value: next ? "true" : null });

  if (!triageEnabled) return null;

  const open = !collapsed;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !loading && active.length === 0 && snoozed.length === 0;
  // A team tag on every row says nothing until there are two teams to tell apart.
  const teams = new Set([...active, ...snoozed].map((t) => t.team).filter(Boolean));
  const showTeam = teams.size > 1;
  const openRotation = schedules.find((s) => rotationKey(s) === rotationFor) ?? null;

  const row = (ticket: TriageTicket, indent: number, isSnoozed: boolean) => (
    <TicketRow
      key={ticket.id}
      repo={repo}
      ticket={ticket}
      indent={indent}
      active={openTicket === ticket.id}
      snoozed={isSnoozed}
      showTeam={showTeam}
      agents={agentsByTicket.get(ticket.id) ?? NO_AGENTS}
      onSelect={() => select(ticket.id)}
      onHover={() => onHover(ticket.id)}
      onOpenAgent={openAgentRow}
    />
  );

  return (
    <div className="flex flex-none flex-col">
      {/* The PROJECTS header register, with a stretched fold toggle under a real
          control (the scope menu) beside it — nested, it would vanish from the
          accessibility tree. The chevron rides inline after the count and shows
          itself on hover or focus, or while folded, as the repo headers' do.
          Inline, not at the trailing edge: a slot held open beside the menu was
          a gap the header wore all day for a glyph it showed on hover. Here it
          appears in room that was empty, and nothing moves. */}
      <div className="group relative mt-2 flex h-8 flex-none items-center gap-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-5">
        <button
          type="button"
          onClick={() => setCollapsed(open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} triage`}
          className="absolute inset-0 cursor-pointer"
        />
        <span className="pointer-events-none">Triage</span>
        {/* Reference, not an alarm: the register the Reviews band's own count
            wears. A tinted pill here read as a warning on a rail that is open all
            day. Under the stretched toggle it can't carry a title, so the noun a
            bare number needs is `sr-only`. */}
        {active.length > 0 && (
          <span className="pointer-events-none font-mono text-[10px] font-normal tracking-normal text-muted-4 tabular-nums">
            {active.length}
            <span className="sr-only"> in the queue</span>
          </span>
        )}
        <Chevron
          size={10}
          className={`pointer-events-none -ml-0.5 flex-none text-muted-4 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
            open ? "opacity-0" : "opacity-100"
          }`}
        />
        <span className="relative ml-auto flex items-center">
          <ScopeMenu goodCitizen={goodCitizen} onChange={setGoodCitizen} />
        </span>
      </div>

      {open && (
        <div className="pb-1">
          {schedules.map((schedule) => (
            <RotationRow
              key={rotationKey(schedule)}
              schedule={schedule}
              showTeam={schedules.length > 1}
              onOpen={() => setRotationFor(rotationKey(schedule))}
            />
          ))}

          {loading && <TicketSkeleton />}

          {empty && (
            <div
              className="py-(--density-compact) text-[11px] text-muted-4"
              style={{ paddingLeft: SECTION_GUTTER }}
            >
              Nothing in triage
            </div>
          )}

          {active.map((ticket) => row(ticket, SECTION_GUTTER, false))}

          {snoozed.length > 0 && (
            <>
              {/* A lane, not a destination: it folds, so it wears the band register
                  and no selection fill. Closed by default — a parked ticket is
                  parked precisely so it stops taking up the queue's room. */}
              <div
                className="tree-band relative flex items-center gap-1.5 px-2 py-(--density-compact)"
                style={{ marginLeft: BAND_GUTTER, marginRight: CARD_INSET }}
              >
                <button
                  type="button"
                  onClick={() => setSnoozedOpen((o) => !o)}
                  aria-expanded={snoozedOpen}
                  aria-label={`${snoozedOpen ? "Collapse" : "Expand"} snoozed tickets`}
                  className="absolute inset-0 cursor-pointer"
                />
                {snoozedOpen ? (
                  <ChevronDownIcon
                    size={9}
                    className="pointer-events-none flex-none text-muted-4"
                  />
                ) : (
                  <ChevronRightIcon
                    size={9}
                    className="pointer-events-none flex-none text-muted-4"
                  />
                )}
                <SnoozeIcon size={11} className="pointer-events-none flex-none text-muted-4" />
                <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-2">
                  Snoozed
                </span>
                <span className="pointer-events-none flex-none font-mono text-[10px] text-muted-4 tabular-nums">
                  {snoozed.length}
                </span>
              </div>
              {snoozedOpen && snoozed.map((ticket) => row(ticket, BAND_ROW_GUTTER, true))}
            </>
          )}
        </div>
      )}
      {openRotation && (
        <RotationDialog schedule={openRotation} onClose={() => setRotationFor(null)} />
      )}
    </div>
  );
}

/** The two scopes the queue can show, in menu order. `value` is the
 *  good-citizen setting each one writes. */
const SCOPES = [
  { value: false, label: "Mine", hint: "Only the tickets assigned to you" },
  { value: true, label: "All", hint: "The whole team's inbox" },
] as const;

/** Whose tickets the queue shows, as a menu on the header: the trigger is the
 *  current scope in the header's own register, and the menu names both scopes
 *  with what each one shows. It replaced a Mine/All pair whose pressed half wore
 *  a fill — at ten pixels, on a rail that is open all day, that read as a hover
 *  that never cleared, beside a word too dim to read as the other choice. */
function ScopeMenu({
  goodCitizen,
  onChange,
}: {
  goodCitizen: boolean;
  onChange: (next: boolean) => void;
}) {
  const current = SCOPES.find((scope) => scope.value === goodCitizen) ?? SCOPES[0];
  return (
    <Dropdown
      align="right"
      menuClassName="w-56 overflow-hidden"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={`Triage scope: ${current.label}`}
          title="Whose tickets the queue shows"
          className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-4 transition-colors hover:text-fg-2"
        >
          {current.label}
          <ChevronDownIcon size={9} className="flex-none" />
        </button>
      )}
    >
      {(close) =>
        SCOPES.map((scope) => {
          const checked = scope.value === goodCitizen;
          return (
            <button
              key={scope.label}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              onClick={() => {
                close();
                onChange(scope.value);
              }}
              className={`${MENU_ITEM} items-start`}
            >
              {/* The check keeps its column whether or not it is drawn, so the
                  two rows' labels line up. */}
              <span className="flex h-4 w-3 flex-none items-center text-fg">
                {checked && <CheckIcon size={11} />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={checked ? "text-fg" : undefined}>{scope.label}</span>
                <span className="text-[11px] text-muted-3">{scope.hint}</span>
              </span>
            </button>
          );
        })
      }
    </Dropdown>
  );
}

/**
 * One triage rotation — who has it now, and until when — as a row that opens
 * the whole schedule in a dialog ({@link RotationDialog}).
 *
 * It used to fold open in place to every shift, which put seven avatars and
 * seven date ranges in a rail whose other rows are tickets. The row keeps the
 * one fact worth a glance — who, and the hand-off date — and a click brings the
 * rest. "You" when it is you, and an uncovered rotation says so in muted ink
 * rather than pretending someone holds it.
 */
function RotationRow({
  schedule,
  showTeam,
  onOpen,
}: {
  schedule: TriageSchedule;
  /** More than one rotation is on screen, so each names its team. */
  showTeam: boolean;
  onOpen: () => void;
}) {
  const who = schedule.currentIsMe ? "You" : schedule.currentName;
  const current = schedule.shifts.find((shift) => shift.isCurrent);
  return (
    <div
      className="tree-row relative flex items-center gap-1.5 px-2 py-(--density-compact)"
      style={{ marginLeft: BAND_GUTTER, marginRight: CARD_INSET }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Show the ${schedule.team} triage rotation`}
        title={`${schedule.scheduleName} — who is on triage, and when it changes hands`}
        className="absolute inset-0 cursor-pointer"
      />
      {schedule.currentName ? (
        <Avatar name={schedule.currentName} src={schedule.currentAvatarUrl} size={14} />
      ) : (
        <span
          aria-hidden
          className="flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong font-mono text-[8px] text-muted-4"
        >
          ?
        </span>
      )}
      <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-2">
        {who ?? <span className="text-muted-4">uncovered</span>}
      </span>
      {showTeam && <span className="tree-tag pointer-events-none">{schedule.team}</span>}
      {current && (
        <span className="pointer-events-none flex-none font-mono text-[10px] whitespace-nowrap text-muted-4">
          {formatShiftRange(current.startsAtMs, current.endsAtMs)}
        </span>
      )}
    </div>
  );
}

/**
 * One ticket, as a card.
 *
 * Two lines, the way a worktree card is: identity first — a Linear glyph in the
 * gutter, the id as a tag, the priority bars, and at the trailing edge the one
 * thing worth a colour here, the SLA clock (or the wake date on a snoozed
 * ticket, which is reference and stays grey) — then the title. The title and
 * everything under it hang from the glyph's label column, so an investigation's
 * row reads as something *inside* the card rather than a sibling of it.
 *
 * `data-ticket-id` is what the j/k keys scroll into view.
 */
function TicketRow({
  repo,
  ticket,
  indent,
  active,
  snoozed,
  showTeam,
  agents,
  onSelect,
  onHover,
  onOpenAgent,
}: {
  /** The repo whose Linear org the queue reads — where the menu's writes go. */
  repo: string;
  ticket: TriageTicket;
  /** The gutter its text column earns — the card overhangs it by `CARD_INSET`. */
  indent: number;
  /** The workspace has this ticket open. */
  active: boolean;
  /** Dimmed, and labelled with its wake date instead of its SLA. */
  snoozed: boolean;
  showTeam: boolean;
  agents: AgentNode[];
  onSelect: () => void;
  onHover: () => void;
  onOpenAgent: (agent: AgentNode) => void;
}) {
  return (
    <TriageTicketMenu repo={repo} ticket={ticket}>
      <div
        className="tree-card relative"
        data-active={active}
        data-ticket-id={ticket.id}
        style={{
          marginLeft: indent - CARD_INSET,
          marginRight: CARD_INSET,
          opacity: snoozed ? 0.62 : 1,
        }}
      >
        <div
          className="relative py-(--density-standard) pr-1.5"
          style={{ paddingLeft: CARD_INSET }}
        >
          <button
            type="button"
            onClick={onSelect}
            // Warms the detail cache so the click renders instantly.
            onMouseEnter={onHover}
            aria-label={`Open ${ticket.id}`}
            title={ticket.title}
            className="absolute inset-0 cursor-pointer"
          />
          <div className="flex items-center gap-1.5">
            <span aria-hidden className="flex flex-none items-center text-muted-4">
              <LinearLogo size={CARD_GLYPH} />
            </span>
            <span className="tree-tag font-mono tabular-nums">{ticket.id}</span>
            {ticket.priority !== "None" && <PriorityBars priority={ticket.priority} />}
            {showTeam && ticket.team && <span className="tree-tag">{ticket.team}</span>}
            <span className="ml-auto flex flex-none items-center">
              {snoozed && ticket.snoozedUntilMs != null ? (
                <span
                  className="font-mono text-[9px] text-muted-4 tabular-nums"
                  title="Snoozed until"
                >
                  {formatSnoozeLabel(ticket.snoozedUntilMs)}
                </span>
              ) : (
                <SlaSignal breachMs={ticket.slaBreachMs} />
              )}
            </span>
          </div>
          <MarkdownTitle
            className={`mt-0.5 block truncate text-[12.5px] leading-[18px] font-medium ${
              active ? "text-fg" : "text-fg-2"
            }`}
            style={{ paddingLeft: CARD_LABEL_X - CARD_INSET }}
          >
            {ticket.title}
          </MarkdownTitle>
        </div>
        {agents.map((agent) => (
          <AgentRow
            key={agentKey(agent.entry)}
            node={agent}
            indent={CARD_LABEL_X}
            onOpen={() => onOpenAgent(agent)}
          />
        ))}
        {/* The card's own bottom padding, so the last agent row isn't flush with
          the highlight's edge. Zero when there is nothing under the title. */}
        {agents.length > 0 && <div className="h-1" />}
      </div>
    </TriageTicketMenu>
  );
}

/** Placeholder rows for the cold load: an unresolved queue must never read as
 *  "nothing in triage". Shaped like the row they stand in for — the id line,
 *  then the title — at the row's own gutter, so nothing shifts when the read
 *  lands. Widths are derived from the index, not random, so a re-render doesn't
 *  reshuffle them. */
function TicketSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="py-(--density-standard) pr-3"
          style={{ paddingLeft: SECTION_GUTTER }}
        >
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-3 w-3 rounded-full" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton
            className="mt-1.5 h-3"
            style={{ marginLeft: CARD_LABEL_X - CARD_INSET, width: `${[72, 58, 66][i]}%` }}
          />
        </div>
      ))}
    </div>
  );
}
