/** Compact, reusable signals for work/review rows. They answer three different
 * scanning questions without adding label-heavy pills: urgency, effort, and a
 * project's delivery horizon. */
import type { ReactNode } from "react";

import type { CycleRef, Priority, ProjectMilestoneRef, TaskStatus } from "../bindings";
import { BULK_TOGGLE_HINT, isBulkToggle } from "../lib/disclosure";
import { formatDay } from "../lib/relativeTime";
import { PROJECT_FALLBACK, priorityColor, statusColor, statusLabel } from "../theme/colors";
import { ChevronDownIcon, ChevronRightIcon, CycleIcon, EstimateIcon } from "./icons";
import { ProjectGlyph } from "./primitives";

export const NO_MILESTONE = "No milestone";

/** Width of one nesting level in a work rail. Small on purpose: a rail is three
 *  or four levels deep inside a few hundred pixels, and a wider step starves the
 *  text column it is indenting.
 *
 *  It lives here, beside the shared headings the rails hang off, because the
 *  failure mode is two rails drifting: the app sidebar and the Reviews rail draw
 *  the same project → milestone → rows ladder, and a number copied into one of
 *  them is a number that only gets tuned in one of them. */
export const INDENT_PX = 14;

/** How far a selectable card overhangs its own row's text. The highlight starts
 *  one inset before the title rather than at the rail's edge, so it reads as an
 *  object you picked and not as a band across the window — a card under a
 *  milestone heading stays inside its group instead of stretching left past it.
 *  The text pays the inset back as padding, so its gutter is absolute and nothing
 *  shifts when the card lights up. */
export const CARD_INSET = 6;

/** The glyph that leads a card's title — a worktree's branch mark, a PR's state
 *  mark. One size for both, because the two cards sit in the same rail and their
 *  titles have to start in the same column. */
export const CARD_GLYPH = 12;

/**
 * Where a card's own words start, measured from the card's edge: its inset, its
 * leading glyph, and the gap after it.
 *
 * This is the column anything *inside* a card hangs from — the agents under a
 * worktree, the agents under a pull request. Same rule as {@link BAND_LABEL_X}
 * one level up: a child begins where its parent's label begins, so its own glyph
 * leads from there and its text lands further in still. Start a child level with
 * the title instead and it reads as the card's sibling, which is the one thing a
 * card's insides must not do.
 */
export const CARD_LABEL_X = CARD_INSET + CARD_GLYPH + 6;

/**
 * Where a heading's own words start, measured from the gutter it is given: its
 * `px-2`, its chevron, and the gap between them.
 *
 * A row that hangs under a heading is indented by this, not by the heading's
 * gutter — otherwise its text lines up with the *chevron* above it and the row
 * reads as the heading's sibling rather than its child. That is exactly how deep
 * a rail looks flat.
 */
export const BAND_LABEL_X = 23;

/** The same measure for {@link ProjectHeading}, which carries a project glyph and
 *  a second gap before its label. */
export const PROJECT_LABEL_X = 35;

export interface MilestoneGroup<T> {
  key: string;
  label: string;
  targetDate: string | null;
  sortOrder: number;
  items: T[];
}

/** Group an already-ordered project list by Linear milestone. Linear's manual
 * milestone order wins; names and ids make ties deterministic, and unassigned
 * work always stays in one trailing bucket. Item order within a bucket is stable. */
export function groupByMilestone<T>(
  items: T[],
  milestoneOf: (item: T) => ProjectMilestoneRef | null | undefined,
): MilestoneGroup<T>[] {
  const groups = new Map<string, MilestoneGroup<T>>();
  for (const item of items) {
    const milestone = milestoneOf(item);
    const key = milestone?.id ?? NO_MILESTONE;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      label: milestone?.name ?? NO_MILESTONE,
      targetDate: milestone?.targetDate ?? null,
      sortOrder: milestone?.sortOrder ?? Number.POSITIVE_INFINITY,
      items: [item],
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === NO_MILESTONE) return 1;
    if (b.key === NO_MILESTONE) return -1;
    return (
      a.sortOrder - b.sortOrder || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
    );
  });
}

/** A lone unassigned bucket conveys no structure. Keep it only when it contrasts
 * with at least one real milestone in the same project. */
export function showMilestoneGroups(groups: { key: string }[]): boolean {
  return groups.length !== 1 || groups[0]?.key !== NO_MILESTONE;
}

/** Heading for work whose issue carries no Linear project. Deliberately the same
 * words the backend already gives such an issue (`linear.rs` `project_fields`),
 * so a row with no ticket at all and a ticket with no project land in one band
 * instead of two that mean the same thing. */
export const NO_PROJECT = "No Project";

/** The Linear project fields a heading needs, however the row supplies them. */
export interface ProjectRef {
  name: string;
  color: string | null;
  icon: string | null;
  targetDate: string | null;
}

export interface ProjectGroup<T> {
  key: string;
  label: string;
  color: string | null;
  icon: string | null;
  targetDate: string | null;
  items: T[];
}

/** Group an already-ordered list by Linear project. Linear gives a project no
 * manual order, so a band keeps the position its first item had — the caller has
 * already ranked the items (by attention, in the sidebar), and the band holding
 * the most urgent one leads. Unassigned work stays in one trailing bucket, as it
 * does for milestones, and item order within a band is stable. */
export function groupByProject<T>(
  items: T[],
  projectOf: (item: T) => ProjectRef | null | undefined,
): ProjectGroup<T>[] {
  const groups = new Map<string, ProjectGroup<T>>();
  for (const item of items) {
    const project = projectOf(item);
    const key = project?.name || NO_PROJECT;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      label: key,
      color: project?.color ?? null,
      icon: project?.icon ?? null,
      targetDate: project?.targetDate ?? null,
      items: [item],
    });
  }
  // Stable sort, so everything but the trailing catch-all keeps insertion order.
  return [...groups.values()].sort(
    (a, b) => Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT),
  );
}

/** Stricter than {@link showMilestoneGroups}, and on purpose: a milestone name
 * and target date state a delivery horizon its section header does not, but a
 * lone project heading only restates the section it sits inside. Keep project
 * headings once there are two bands to tell apart. */
export function showProjectGroups(groups: { key: string }[]): boolean {
  return groups.length > 1;
}

/** Linear's priority mark, and its colour here: three bars filled to the level,
 *  three short dashes for no priority (only where the column has to stay put —
 *  a list — since elsewhere "nothing" is best said by nothing), and Urgent as
 *  the boxed mark it is in Linear, because a fourth bar reads as "a bit more
 *  than high" and Urgent is a different kind of thing. */
export function PriorityBars({
  priority,
  showNone = false,
}: {
  priority: Priority;
  /** Draw the three dashes for "no priority" instead of nothing. */
  showNone?: boolean;
}) {
  const label = priority === "None" ? "No priority" : `${priority} priority`;
  if (priority === "None") {
    if (!showNone) return null;
    return (
      <span role="img" aria-label={label} title={label} className="flex h-2.5 items-center gap-px">
        {Array.from({ length: 3 }, (_, index) => (
          <span key={index} className="h-[1.5px] w-[3px] rounded-[1px] bg-muted-4" />
        ))}
      </span>
    );
  }
  const color = priorityColor[priority];
  if (priority === "Urgent") {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className="flex h-[11px] w-[11px] items-center justify-center rounded-[2.5px] font-mono text-[8.5px] leading-none font-bold"
        style={{ background: color, color: "var(--on-danger)" }}
      >
        !
      </span>
    );
  }
  const level = priority === "Low" ? 1 : priority === "Medium" ? 2 : 3;
  return (
    <span role="img" aria-label={label} title={label} className="flex h-2.5 items-end gap-px">
      {Array.from({ length: 3 }, (_, index) => (
        <span
          key={index}
          className="w-[3px] rounded-[1px]"
          style={{
            height: 4 + index * 3,
            background: index < level ? color : "var(--color-line-3)",
          }}
        />
      ))}
    </span>
  );
}

/** One estimate value as text — whole points plain, fractions as they are. */
export function formatPoints(points: number): string {
  return Number.isInteger(points) ? points.toFixed(0) : String(points);
}

/** A ticket's estimate: Linear's mark and the points. */
export function EstimateTag({
  estimate,
  className = "text-[10px]",
}: {
  estimate: number;
  className?: string;
}) {
  const value = formatPoints(estimate);
  const label = `${value} point estimate`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex flex-none items-center gap-[3px] font-mono text-muted-3 tabular-nums ${className}`}
    >
      <EstimateIcon size={9} />
      <span>{value}</span>
    </span>
  );
}

/** The points a group adds up to — Linear's mark and the sum, the way its own
 *  group headers carry it. Nothing when nothing under it is estimated. */
export function PointsSum({ points }: { points: number }) {
  if (!points) return null;
  const value = formatPoints(points);
  return (
    <span
      className="flex flex-none items-center gap-[3px] font-mono text-[10px] text-muted-4 normal-case tracking-normal tabular-nums"
      title={`${value} points estimated in this group`}
    >
      <EstimateIcon size={9} />
      {value}
    </span>
  );
}

/** The part of the lap a state has run, for {@link StatusGlyph}. */
const STATUS_FRACTION: Record<TaskStatus, number> = {
  Backlog: 0,
  Todo: 0,
  InProgress: 0.5,
  InReview: 0.75,
  Done: 1,
  Blocked: 0,
};

/**
 * Linear's state mark: a ring in the state's colour, filled as far as the work
 * has come — empty for Todo, dashed for Backlog, half for In Progress, three
 * quarters for In Review, whole with a check for Done, and a ring with a bar
 * across it for Blocked. The hue is the app's own `statusColor`, so this and
 * every state word beside it agree.
 */
export function StatusGlyph({ status, size = 12 }: { status: TaskStatus; size?: number }) {
  const color = statusColor[status];
  const label = statusLabel[status];
  const fraction = STATUS_FRACTION[status];
  // Centre (7, 7), radius 5, in a 14-unit box; the sector runs clockwise from
  // twelve o'clock.
  const angle = 2 * Math.PI * fraction;
  const x = 7 + 5 * Math.sin(angle);
  const y = 7 - 5 * Math.cos(angle);
  return (
    <span role="img" aria-label={label} title={label} className="flex flex-none">
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
        <circle
          cx="7"
          cy="7"
          r="5"
          fill={fraction === 1 ? color : "none"}
          stroke={color}
          strokeWidth="1.5"
          strokeDasharray={status === "Backlog" ? "2 1.6" : undefined}
        />
        {fraction > 0 && fraction < 1 && (
          <path
            d={`M7 7 L7 2 A5 5 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`}
            fill={color}
          />
        )}
        {status === "Done" && (
          <path
            d="M4.6 7.2 L6.4 9 L9.5 5.6"
            fill="none"
            stroke="var(--color-app)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {status === "Blocked" && (
          <path d="M4.5 7 H9.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

/**
 * The cycle a ticket is scheduled into — Linear's ring mark and the cycle's
 * number, the way its own list shows it. The name (when the team names its
 * cycles) and the end date go in the tooltip: a chip reading "Sprint 17 · ends
 * Sep 7" would be wider than the title column it sits beside.
 */
/** How far through a cycle now is, 0–1, or `null` when Linear didn't date it
 *  (or dated it backwards). Time, not scope: it is the ring Linear draws on the
 *  mark, and the one number every ticket in a cycle shares. */
export function cycleProgress(
  cycle: Pick<CycleRef, "startsAtMs" | "endsAtMs">,
  now = Date.now(),
): number | null {
  const { startsAtMs: start, endsAtMs: end } = cycle;
  if (start == null || end == null || end <= start) return null;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function CycleTag({
  cycle,
  className = "text-[9px]",
}: {
  cycle: CycleRef;
  className?: string;
}) {
  // A float on the wire, and `null` in the type only because specta types every
  // f64 that way — Linear numbers its cycles 1, 2, 3.
  const number =
    cycle.number == null
      ? "?"
      : Number.isInteger(cycle.number)
        ? cycle.number.toFixed(0)
        : String(cycle.number);
  const name = cycle.name ?? `Cycle ${number}`;
  const label = cycle.endsAtMs != null ? `${name} · ends ${formatDay(cycle.endsAtMs)}` : name;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex flex-none items-center gap-[3px] font-mono text-muted-3 tabular-nums ${className}`}
    >
      <CycleIcon size={10} progress={cycleProgress(cycle)} />
      <span>{number}</span>
    </span>
  );
}

/** Where a heading's due date sits: at its trailing edge, in the heading's
 *  mono register but out of its uppercase. */
const HEADING_DUE_CLASS = "ml-auto flex-none font-mono text-[9px] normal-case tracking-normal";

/** A date something is due, coloured by how near it is: overdue and imminent
 * dates gain urgency, distant ones stay quiet. Where it sits is the caller's
 * — a heading's trailing edge, a row's signal cluster. */
function DueDateSignal({
  date,
  noun,
  className,
}: {
  date: string | null | undefined;
  noun: "Issue due date" | "Milestone target date" | "Project target date";
  className: string;
}) {
  if (!date) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((parsed.getTime() - today.getTime()) / 86_400_000);
  const label = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(parsed);
  const color =
    days < 0
      ? "var(--color-status-red)"
      : days <= 14
        ? "var(--color-status-amber)"
        : "var(--color-muted-4)";

  return (
    <span className={className} style={{ color }} title={`${noun}: ${parsed.toLocaleDateString()}`}>
      {days < 0 ? "overdue" : "due"} {label}
    </span>
  );
}

/** A project's target date belongs beside the project heading, not repeated on
 *  every task under it. */
export function ProjectDueDate({ date }: { date: string | null | undefined }) {
  return <DueDateSignal date={date} noun="Project target date" className={HEADING_DUE_CLASS} />;
}

export function MilestoneDueDate({ date }: { date: string | null | undefined }) {
  return <DueDateSignal date={date} noun="Milestone target date" className={HEADING_DUE_CLASS} />;
}

/** The ticket's own due date — the one Linear puts at the end of its row. Renders
 *  nothing without one, so a row that has none ends where it did. */
export function IssueDueDate({
  date,
  className = "flex-none font-mono text-[9px]",
}: {
  date: string | null | undefined;
  className?: string;
}) {
  return <DueDateSignal date={date} noun="Issue due date" className={className} />;
}

/**
 * The innermost folding heading a work rail uses — a quiet uppercase label, a
 * count, and whatever trailing signal the level carries.
 *
 * Shared rather than restyled per rail because this register (mono, uppercase,
 * `muted-4`) is what tells a reader "this is a grouping, not a row" everywhere
 * in the app; a second copy of the class list is how one rail's grouping quietly
 * stops looking like a grouping. `noun` is what the accessible name calls the
 * level, so a screen reader hears "Collapse milestone Q3" and "Collapse review
 * group Team · Engineering" rather than one borrowed word for both.
 */
export function BandHeading({
  label,
  count,
  open,
  onToggle,
  noun,
  title,
  points,
  trailing,
}: {
  label: string;
  count: number;
  open: boolean;
  /** `bulk` is the ⌘-click: every heading under this one follows it (see
   *  `lib/disclosure`). Every folding row in the app takes the same gesture, so
   *  it is passed through rather than swallowed here. */
  onToggle: (bulk: boolean) => void;
  /** What this level is, for the accessible name. */
  noun: string;
  /** Hover text, when the label alone is ambiguous (a team's org, say). */
  title?: string;
  /** The estimates under this level, added up. */
  points?: number;
  /** The level's own trailing signal — a due date, a state. */
  trailing?: ReactNode;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={(e) => onToggle(isBulkToggle(e))}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${noun} ${label}`}
      title={title ? `${title}\n${BULK_TOGGLE_HINT}` : BULK_TOGGLE_HINT}
      className="tree-band flex w-full cursor-pointer items-center gap-1.5 px-2 pt-2.5 pb-1.5 text-left font-mono text-[10px] tracking-[.05em] text-muted-4 uppercase hover:text-fg-2"
    >
      <Chevron size={9} className="flex-none" />
      <span className="truncate">{label}</span>
      <span>{count}</span>
      {points !== undefined && <PointsSum points={points} />}
      {trailing}
    </button>
  );
}

/**
 * Shared folding heading for the Linear-project level, one register louder than
 * {@link BandHeading} below it — three registers for three levels, so the depth
 * reads without a rule or a rail. The glyph is the project's own (emoji or
 * colored dot), the one place hue enters a work rail besides the attention dot.
 */
export function ProjectHeading({
  label,
  count,
  color,
  icon,
  targetDate,
  points,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  color: string | null | undefined;
  icon: string | null | undefined;
  targetDate: string | null | undefined;
  /** The estimates under this project, added up. */
  points?: number;
  open: boolean;
  onToggle: (bulk: boolean) => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={(e) => onToggle(isBulkToggle(e))}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} project ${label}`}
      title={BULK_TOGGLE_HINT}
      // No focus styling of its own: THE ring is the one global `:focus-visible`
      // rule in styles.css, and a local override escapes its pointer gate.
      className="tree-band flex w-full cursor-pointer items-center gap-1.5 px-2 pt-2.5 pb-1 text-left text-[11px] font-medium text-muted-3 hover:text-fg-2"
    >
      <Chevron size={9} className="flex-none" />
      <ProjectGlyph color={color ?? PROJECT_FALLBACK} icon={icon ?? null} size={6} />
      <span className="truncate">{label}</span>
      <span className="font-mono text-[10px] text-muted-4 tabular-nums">{count}</span>
      {points !== undefined && <PointsSum points={points} />}
      <ProjectDueDate date={targetDate} />
    </button>
  );
}

/** One step of the stacked-PR ladder. Narrower than {@link INDENT_PX} because it
 *  is spent on a *drawn* connector rather than on empty space: the line is what
 *  says "this branched off the one above", so the gap only has to be wide enough
 *  to hold it. */
export const PR_STACK_INDENT = 12;

/**
 * The elbow that makes a stacked PR read as a child of the one above it.
 *
 * Indentation alone says "these are related"; it does not say *how*, and at one
 * step it reads as a rendering accident. The connector is the same figure a file
 * tree draws — a rule down from the parent, an elbow into the child — so the
 * relationship is legible without a legend. Purely decorative: the branch names
 * behind it are in each row's own tooltip.
 *
 * `guides` says which columns are still live on this row (`stackGuides`), and it
 * is what keeps the figure whole. Drawing every ancestor column full height and
 * every elbow half height put a rule under a last child that led nowhere, and
 * broke the parent's at its elbow — one line stopping and another starting a few
 * pixels below, which is what a reader sees as a cut. A column is drawn here
 * only while its branch has something further down.
 */
export function StackConnector({ guides }: { guides: boolean[] }) {
  if (guides.length === 0) return null;
  return (
    <span
      aria-hidden
      className="relative flex flex-none self-stretch"
      style={{ width: guides.length * PR_STACK_INDENT }}
    >
      {guides.map((live, i) => {
        // The last column is this row's own: it carries the elbow, and its rule
        // runs to the elbow (`└`) or through it to the next sibling (`├`).
        const own = i === guides.length - 1;
        return (
          <span key={i} className="relative" style={{ width: PR_STACK_INDENT }}>
            {(own || live) && (
              <span
                className="absolute top-0 left-0 border-line-2 border-l"
                style={{ height: own && !live ? "50%" : "100%" }}
              />
            )}
            {own && (
              <span
                className="absolute top-1/2 left-0 border-line-2 border-t"
                style={{ width: PR_STACK_INDENT }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Shared folding heading for the milestone level used by all three work rails. */
export function MilestoneHeading({
  label,
  count,
  targetDate,
  points,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  targetDate: string | null | undefined;
  points?: number;
  open: boolean;
  onToggle: (bulk: boolean) => void;
}) {
  return (
    <BandHeading
      label={label}
      count={count}
      points={points}
      open={open}
      onToggle={onToggle}
      noun="milestone"
      trailing={<MilestoneDueDate date={targetDate} />}
    />
  );
}
