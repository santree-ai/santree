/** Compact, reusable signals for work/review rows. They answer three different
 * scanning questions without adding label-heavy pills: urgency, effort, and a
 * project's delivery horizon. */
import type { Priority, ProjectMilestoneRef } from "../bindings";
import { priorityColor, prSizeColor } from "../theme/colors";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

export const NO_MILESTONE = "No milestone";

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

export type ChangeSize = "XS" | "S" | "M" | "L" | "XL";

const SIZE_LEVEL: Record<ChangeSize, number> = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };
const SIZE_LABEL: Record<ChangeSize, string> = {
  XS: "Very small",
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Very large",
};

export function changeSizeOf(additions: number, deletions: number, files: number): ChangeSize {
  const score = additions + deletions + files * 20;
  if (score < 50) return "XS";
  if (score < 200) return "S";
  if (score < 600) return "M";
  if (score < 1500) return "L";
  return "XL";
}

export function ChangeSizeBars({
  additions,
  deletions,
  files,
  noun = "change",
}: {
  additions: number;
  deletions: number;
  files: number;
  noun?: string;
}) {
  const size = changeSizeOf(additions, deletions, files);
  const level = SIZE_LEVEL[size];
  const color = prSizeColor[size];
  const detail = `${SIZE_LABEL[size]} ${noun}: ${files} file${files === 1 ? "" : "s"}, +${additions} −${deletions}`;
  return (
    <span role="img" aria-label={detail} title={detail} className="flex h-2 items-center gap-[2px]">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className="h-[4px] w-[3px] rounded-[1px]"
          style={{ background: index < level ? color : "var(--color-line-3)" }}
        />
      ))}
    </span>
  );
}

const PRIORITY_LEVEL: Record<Exclude<Priority, "None">, number> = {
  Low: 1,
  Medium: 2,
  High: 3,
  Urgent: 4,
};

export function PriorityBars({ priority }: { priority: Exclude<Priority, "None"> }) {
  const level = PRIORITY_LEVEL[priority];
  const color = priorityColor[priority];
  return (
    <span
      role="img"
      aria-label={`${priority} priority`}
      title={`${priority} priority`}
      className="flex h-2.5 items-end gap-px"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <span
          key={index}
          className="w-[2px] rounded-[1px]"
          style={{
            height: 3 + index * 1.5,
            background: index < level ? color : "var(--color-line-3)",
          }}
        />
      ))}
    </span>
  );
}

/** Linear's estimate is the best available pre-work difficulty signal. Workspaces
 * may use Fibonacci points, so map the common 1/2/3/5/8 scale onto five bars
 * instead of pretending the raw number is a universal duration. */
export function EstimateBars({ estimate }: { estimate: number }) {
  const level = estimate <= 1 ? 1 : estimate <= 2 ? 2 : estimate <= 3 ? 3 : estimate <= 5 ? 4 : 5;
  const value = Number.isInteger(estimate) ? estimate.toFixed(0) : String(estimate);
  const label = `${value} point estimate`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex items-center gap-1 font-mono text-[9px] text-muted-3"
    >
      <span className="flex h-2 items-end gap-px">
        {Array.from({ length: 5 }, (_, index) => (
          <span
            key={index}
            className="w-[2px] rounded-[1px]"
            style={{
              height: 3 + index,
              background: index < level ? "var(--accent)" : "var(--color-line-3)",
            }}
          />
        ))}
      </span>
      <span>{value}</span>
    </span>
  );
}

/** A project's target date belongs beside the project heading, not repeated on
 * every task. Near and overdue dates gain urgency; distant dates stay quiet. */
function DueDateSignal({
  date,
  noun,
}: {
  date: string | null | undefined;
  noun: "Issue due date" | "Milestone target date" | "Project target date";
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
    <span
      className="ml-auto flex-none font-mono text-[9px] normal-case tracking-normal"
      style={{ color }}
      title={`${noun}: ${parsed.toLocaleDateString()}`}
    >
      {days < 0 ? "overdue" : "due"} {label}
    </span>
  );
}

export function ProjectDueDate({ date }: { date: string | null | undefined }) {
  return <DueDateSignal date={date} noun="Project target date" />;
}

export function MilestoneDueDate({ date }: { date: string | null | undefined }) {
  return <DueDateSignal date={date} noun="Milestone target date" />;
}

/** Shared folding heading for the milestone level used by all three work rails. */
export function MilestoneHeading({
  label,
  count,
  targetDate,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  targetDate: string | null | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} milestone ${label}`}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 pt-2.5 pb-1.5 text-left font-mono text-[10px] tracking-[.05em] text-muted-4 uppercase transition-colors hover:bg-hover hover:text-fg-2"
    >
      <Chevron size={9} className="flex-none" />
      <span className="truncate">{label}</span>
      <span>{count}</span>
      <MilestoneDueDate date={targetDate} />
    </button>
  );
}

export function IssueDueDate({ date }: { date: string | null | undefined }) {
  return <DueDateSignal date={date} noun="Issue due date" />;
}
