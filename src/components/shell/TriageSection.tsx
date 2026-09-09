/**
 * The sidebar's Triage section: the queue by team — each team a folding row
 * with who is on its rotation at the trailing edge, its tickets under it, then
 * what is snoozed there; each ticket a row with its investigations underneath.
 *
 * Triage used to be a destination with a rail of its own. The rail listed the
 * same tickets this section does, one click away from a permanent sidebar that
 * could have shown them all along — so the queue moved here, and `/triage` is
 * now only the workspace for the ticket you picked (`/triage?ticket=`).
 *
 * A person is often in more than one rotation, and holds triage tickets on
 * teams whose rotation they are not in at all — so the section is organised by
 * team, the way the tree is organised by project. The teams are the backend's
 * scope (`triage_schedule` and the queue share it): the rotations you are in
 * first, then the teams that hold a ticket of yours (see `triageTeams`).
 *
 * It speaks the tree's own vocabulary: the header is the PROJECTS register, a
 * team row is the repo-header register (a fold toggle with a real control at
 * its trailing edge — the rotation chip, which opens the schedule in a
 * dialog), the Snoozed lane is a `.tree-band` container (it folds, it opens
 * nothing), and
 * every ticket is a `.tree-card` — a destination, lit while the workspace
 * shows it, with the ticket's own menu on a right-click (`TriageTicketMenu`).
 * Selection follows the route and nothing else, the same rule the project
 * tree's worktree rows follow.
 *
 * It scrolls with the sidebar, not inside it: the queue is a section of the
 * rail like the projects under it, and folding the section is how you stop
 * seeing it. It used to cap itself at 40vh behind a scrollbar of its own, which
 * read as a widget dropped into the sidebar rather than a part of it.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import type { TriageSchedule, TriageTicket } from "../../bindings";
import { agentKey } from "../../features/agents/registry";
import { useOpenAgent } from "../../features/agents/useOpenAgent";
import {
  TRIAGE_GOOD_CITIZEN_KEY,
  type TriageTeamScope,
  usePrefetchOnHover,
  useSetSetting,
  useTriageOrgRepo,
  useTriageQueue,
  useTriageSchedule,
  useTriageTeamScopes,
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
import { groupTriageByTeam, type TriageTeamGroup } from "./triageTeams";
import { type AgentNode, useTicketAgents } from "./useProjectTree";

/** The section's own fold, each team's row inside it, and each team's Snoozed
 *  band, the last two by team key. Each holds "not the default" — open, open,
 *  closed — so none needs seeding. */
const COLLAPSED_KEY = "santree.shell.triage.collapsed";
const FOLDED_TEAMS_KEY = "santree.shell.triage.foldedTeams";
const SNOOZED_OPEN_KEY = "santree.shell.triage.snoozedOpenByTeam";

/** Where the section's rows hang from: the header label's own column (`px-4`),
 *  the same rule the Projects label and its repo headers follow. A team row
 *  sits here too, and so do its tickets — see `team` below. */
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

/** A schedule read that hasn't landed grouping as no schedules: the same
 *  array each render, so the grouping memo holds. */
const NO_SCHEDULES: TriageSchedule[] = [];

export function TriageSection() {
  const { triageEnabled } = useApp();
  const navigate = useNavigate();
  // The queue is read from the triage org's repo, which the workspace resolves
  // through the same hook, so the two can never show different queues. Two
  // Linear calls ride on it, so while the section isn't drawn the *repo* is
  // blanked — never the hook call, which has to run on every render.
  const orgRepo = useTriageOrgRepo();
  const repo = triageEnabled ? orgRepo : "";
  const queue = useTriageQueue(repo);
  const { active, snoozed, goodCitizen, teamScopes } = queue;
  const { setScope } = useTriageTeamScopes();
  const { data: schedules = NO_SCHEDULES, isLoading: schedulesLoading } = useTriageSchedule(repo);
  // Both reads shape the section — a ticket lands under its team's row — so
  // it is loading until both have landed, and skeletons stand in for the pair.
  const loading = queue.loading || schedulesLoading;
  const setSetting = useSetSetting();
  const onHover = usePrefetchOnHover(repo);
  const { agentsByTicket, markSeen } = useTicketAgents();
  const openAgent = useOpenAgent();
  const [collapsed, setCollapsed] = usePersistedState(COLLAPSED_KEY, false);
  const [foldedTeams, setFoldedTeams] = usePersistedState<Record<string, boolean>>(
    FOLDED_TEAMS_KEY,
    {},
  );
  // The team whose schedule is open in the dialog, by key. View state, not
  // persisted: a dialog that reopened itself on relaunch would be a surprise.
  const [rotationFor, setRotationFor] = useState<string | null>(null);
  const [snoozedOpen, setSnoozedOpen] = usePersistedState<Record<string, boolean>>(
    SNOOZED_OPEN_KEY,
    {},
  );
  // The ticket the workspace has open — the rail's one selection, read off the
  // route so it can't disagree with what the content area shows. A plain string,
  // so an unrelated navigation doesn't re-render the section on a fresh identity.
  const openTicket = useRouterState({
    select: (s) =>
      s.location.pathname.startsWith("/triage")
        ? ((s.location.search as { ticket?: string }).ticket ?? null)
        : null,
  });

  const groups = useMemo(
    () => groupTriageByTeam(active, snoozed, schedules),
    [active, snoozed, schedules],
  );

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
  // The header's Mine/All *is* the "be a good citizen" setting — the default
  // every team follows until its own row says otherwise. All widens a team to
  // its whole inbox (issues not assigned to you included).
  const setGoodCitizen = (next: boolean) =>
    setSetting.mutate({ scope: "app", key: TRIAGE_GOOD_CITIZEN_KEY, value: next ? "true" : null });
  const openTeamSettings = () => navigate({ to: "/settings", search: { section: "triage" } });

  if (!triageEnabled) return null;

  const open = !collapsed;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  const empty = !loading && active.length === 0 && snoozed.length === 0;
  const openRotation = groups.find((g) => g.key === rotationFor)?.schedule ?? null;

  const row = (ticket: TriageTicket, indent: number, isSnoozed: boolean) => (
    <TicketRow
      key={ticket.id}
      repo={repo}
      ticket={ticket}
      indent={indent}
      active={openTicket === ticket.id}
      snoozed={isSnoozed}
      agents={agentsByTicket.get(ticket.id) ?? NO_AGENTS}
      onSelect={() => select(ticket.id)}
      onHover={() => onHover(ticket.id)}
      onOpenAgent={openAgentRow}
    />
  );

  /** One team: its row, its queue, then its snoozed lane. A team with nothing
   *  in it is still drawn — a rotation you are in is worth a line whether or
   *  not it is busy — and so is the row of the only team, since it is what
   *  names the team and what folds it. The tickets keep the section's own
   *  gutter: the team row is a divider over a flat list of like rows, and
   *  folding is what says "these are its", not an indent. */
  const team = (group: TriageTeamGroup) => {
    const folded = !!foldedTeams[group.key];
    const lane = group.key;
    const laneOpen = !!snoozedOpen[lane];
    const rotation =
      group.schedule && group.schedule.shifts.length > 0
        ? () => setRotationFor(group.key)
        : undefined;
    return (
      <div key={group.key}>
        {group.key && (
          <TeamRow
            name={group.name}
            count={group.active.length}
            open={!folded}
            onToggle={() => setFoldedTeams((m) => ({ ...m, [group.key]: !m[group.key] }))}
            scope={teamScopes[group.key] ?? (goodCitizen ? "all" : "mine")}
            overridden={group.key in teamScopes}
            onScope={(next) => setScope(group.key, next)}
            schedule={group.schedule}
            onOpenRotation={rotation}
          />
        )}

        {!folded && group.active.map((ticket) => row(ticket, SECTION_GUTTER, false))}

        {!folded && group.snoozed.length > 0 && (
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
                onClick={() => setSnoozedOpen((o) => ({ ...o, [lane]: !o[lane] }))}
                aria-expanded={laneOpen}
                aria-label={`${laneOpen ? "Collapse" : "Expand"} snoozed tickets${
                  group.key ? ` for ${group.name}` : ""
                }`}
                className="absolute inset-0 cursor-pointer"
              />
              {laneOpen ? (
                <ChevronDownIcon size={9} className="pointer-events-none flex-none text-muted-4" />
              ) : (
                <ChevronRightIcon size={9} className="pointer-events-none flex-none text-muted-4" />
              )}
              <SnoozeIcon size={11} className="pointer-events-none flex-none text-muted-4" />
              <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-2">
                Snoozed
              </span>
              <span className="pointer-events-none flex-none font-mono text-[10px] text-muted-4 tabular-nums">
                {group.snoozed.length}
              </span>
            </div>
            {laneOpen && group.snoozed.map((ticket) => row(ticket, BAND_ROW_GUTTER, true))}
          </>
        )}
      </div>
    );
  };

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
          <ScopeMenu
            goodCitizen={goodCitizen}
            onChange={setGoodCitizen}
            onOpenTeams={openTeamSettings}
          />
        </span>
      </div>

      {open && (
        <div className="pb-1">
          {loading ? <TicketSkeleton /> : groups.map(team)}

          {empty && (
            <div
              className="py-(--density-compact) text-[11px] text-muted-4"
              style={{ paddingLeft: SECTION_GUTTER }}
            >
              Nothing in triage
            </div>
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

/** Whose tickets the queue shows by default, as a menu on the header: the
 *  trigger is the current default in the header's own register, and the menu
 *  names both scopes with what each one shows — a team's own row can say
 *  otherwise for that team — then the way to Settings, where which teams are
 *  here at all is decided. It replaced a Mine/All pair whose pressed half wore
 *  a fill — at ten pixels, on a rail that is open all day, that read as a hover
 *  that never cleared, beside a word too dim to read as the other choice. */
function ScopeMenu({
  goodCitizen,
  onChange,
  onOpenTeams,
}: {
  goodCitizen: boolean;
  onChange: (next: boolean) => void;
  onOpenTeams: () => void;
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
      {(close) => (
        <>
          {SCOPES.map((scope) => {
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
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onOpenTeams();
            }}
            className={`${MENU_ITEM} border-t border-line`}
          >
            <span className="w-3 flex-none" />
            <span className="flex min-w-0 flex-col">
              <span>Teams…</span>
              <span className="text-[11px] text-muted-3">Which teams show up here</span>
            </span>
          </button>
        </>
      )}
    </Dropdown>
  );
}

/** A team's own Mine/All, on its row: two words, the one in force lit. Shown
 *  on hover, or always once the team has left the header's default, so a team
 *  that differs from the rest says so at rest. Sits beside the rotation chip,
 *  above the row's stretched fold button, so a click here sets the scope and
 *  folds nothing. */
function ScopeSwitch({
  team,
  scope,
  overridden,
  onChange,
}: {
  team: string;
  scope: TriageTeamScope;
  overridden: boolean;
  onChange: (next: TriageTeamScope) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a block box and a border reset the row's inline layout can't take; the role is the whole of what it needs.
    <span
      role="group"
      aria-label={`${team} tickets`}
      className={`relative flex flex-none items-center gap-px rounded transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
        overridden ? "opacity-100" : "opacity-0"
      }`}
    >
      {(
        [
          ["mine", "Mine", "Only the tickets assigned to you"],
          ["all", "All", "The whole team's inbox"],
        ] as const
      ).map(([value, label, hint]) => {
        const on = value === scope;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            aria-label={`${label}: ${hint}`}
            title={hint}
            onClick={() => onChange(value)}
            className={`cursor-pointer rounded px-1 py-px font-mono text-[9px] uppercase tracking-[0.06em] transition-colors ${
              on ? "bg-(--tree-tag-fill) text-fg-2" : "text-muted-4 hover:text-fg-2"
            }`}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

/**
 * One team's row — the repo-header register:
 * the name at the section's gutter, its queue count, the fold chevron inline
 * after them (on hover, or while folded), the whole row a fold toggle, and at
 * the trailing edge a real control beside it: the rotation chip, who has it
 * now, which opens the whole schedule ({@link RotationDialog}). Its tickets
 * sit at the same gutter; folding, not an indent, is what makes them its.
 */
function TeamRow({
  name,
  count,
  open,
  onToggle,
  scope,
  overridden,
  onScope,
  schedule,
  onOpenRotation,
}: {
  name: string;
  /** Active tickets under the row. */
  count: number;
  open: boolean;
  onToggle: () => void;
  /** The team's Mine/All in force — its own, else the header's default. */
  scope: TriageTeamScope;
  /** The team has a scope of its own. */
  overridden: boolean;
  onScope: (next: TriageTeamScope) => void;
  /** The team's rotation card, when the schedule read has it. */
  schedule: TriageSchedule | null;
  /** Absent when there is no schedule to show. */
  onOpenRotation?: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      className="group relative flex items-center gap-1.5 py-(--density-compact) pr-1.5"
      style={{ paddingLeft: SECTION_GUTTER, marginRight: CARD_INSET }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
        className="absolute inset-0 cursor-pointer"
      />
      <span className="pointer-events-none min-w-0 truncate text-[12px] font-semibold text-fg-2">
        {name}
      </span>
      {count > 0 && (
        <span className="pointer-events-none font-mono text-[10px] text-muted-4 tabular-nums">
          {count}
          <span className="sr-only"> in the queue</span>
        </span>
      )}
      <Chevron
        size={10}
        className={`pointer-events-none -ml-0.5 flex-none text-muted-4 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
          open ? "opacity-0" : "opacity-100"
        }`}
      />
      <span className="relative ml-auto flex min-w-0 items-center gap-1.5">
        <ScopeSwitch team={name} scope={scope} overridden={overridden} onChange={onScope} />
        {schedule && <RotationChip schedule={schedule} onOpen={onOpenRotation} />}
      </span>
    </div>
  );
}

/** Who has a team's rotation, as a chip on its row: an avatar and "You" or the
 *  name, the hand-off date in the hover text, the whole schedule a click away.
 *  The date used to sit on the row itself; beside the team's name it no longer
 *  fits a rail this narrow, and the name is the fact the row exists for.
 *  An uncovered rotation says so in muted ink rather than pretending someone
 *  holds it; a team with no rotation — one you are in only through a ticket of
 *  yours — says that, and opens nothing. */
function RotationChip({ schedule, onOpen }: { schedule: TriageSchedule; onOpen?: () => void }) {
  const hasRotation = schedule.shifts.length > 0;
  const who = schedule.currentIsMe ? "You" : schedule.currentName;
  const current = schedule.shifts.find((shift) => shift.isCurrent);
  const body = (
    <>
      {hasRotation &&
        (schedule.currentName ? (
          <Avatar name={schedule.currentName} src={schedule.currentAvatarUrl} size={14} />
        ) : (
          <span
            aria-hidden
            className="flex size-3.5 flex-none items-center justify-center rounded-full border border-line-strong font-mono text-[8px] text-muted-4"
          >
            ?
          </span>
        ))}
      <span className={`min-w-0 truncate text-[11px] ${who ? "text-muted-2" : "text-muted-4"}`}>
        {hasRotation ? (who ?? "uncovered") : "no rotation"}
      </span>
    </>
  );
  if (!onOpen) {
    return (
      <span
        className="flex min-w-0 items-center gap-1 px-1"
        title={`${schedule.team} has no triage rotation`}
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Show the ${schedule.team} triage rotation`}
      title={`${schedule.scheduleName}${
        current ? ` · ${formatShiftRange(current.startsAtMs, current.endsAtMs)}` : ""
      }\nWho is on triage, and when it changes hands`}
      className="flex min-w-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-hover"
    >
      {body}
    </button>
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
