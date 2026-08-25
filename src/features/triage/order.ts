import type { Priority, TriageTicket } from "../../bindings";

export const TRIAGE_ORDER_KEY = "triage_order";

export type TriageOrder =
  | "attention"
  | "due-date"
  | "priority"
  | "created-oldest"
  | "created-newest"
  | "manual";

export const TRIAGE_ORDER_OPTIONS: ReadonlyArray<{ value: TriageOrder; label: string }> = [
  { value: "attention", label: "Attention" },
  { value: "due-date", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "created-oldest", label: "Created · oldest" },
  { value: "created-newest", label: "Created · newest" },
  { value: "manual", label: "Manual" },
];

export function parseTriageOrder(value: string | null | undefined): TriageOrder {
  return TRIAGE_ORDER_OPTIONS.some((option) => option.value === value)
    ? (value as TriageOrder)
    : "attention";
}

const priorityRank: Record<Priority, number> = {
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  None: 4,
};

function compareNullable<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compare(a, b);
}

function compareDate(a: string | null, b: string | null) {
  return compareNullable(a, b, (x, y) => x.localeCompare(y));
}

function compareNumber(a: number | null, b: number | null) {
  return compareNullable(a, b, (x, y) => x - y);
}

function stableTieBreak(a: TriageTicket, b: TriageTicket) {
  return a.id.localeCompare(b.id);
}

export function compareTriageTickets(order: TriageOrder, a: TriageTicket, b: TriageTicket) {
  const oldest = () => compareNumber(a.createdAtMs, b.createdAtMs) || stableTieBreak(a, b);
  const due = () => compareDate(a.dueDate, b.dueDate);
  const priority = () => priorityRank[a.priority] - priorityRank[b.priority];

  switch (order) {
    case "attention":
      return compareNumber(a.slaBreachMs, b.slaBreachMs) || due() || priority() || oldest();
    case "due-date":
      return due() || priority() || oldest();
    case "priority":
      return priority() || due() || oldest();
    case "created-newest":
      return compareNumber(b.createdAtMs, a.createdAtMs) || stableTieBreak(a, b);
    case "manual":
      return compareNumber(a.sortOrder, b.sortOrder) || oldest();
    default:
      return oldest();
  }
}

export interface TriageLanes {
  investigations: TriageTicket[];
  queue: TriageTicket[];
  snoozed: TriageTicket[];
}

/** Activity and snooze are operational states, not sort keys. Keeping them in
 * fixed lanes makes every selected order truthful instead of silently moving a
 * running investigation around inside a supposedly manual list. */
export function triageLanes(
  tickets: TriageTicket[],
  order: TriageOrder,
  activityRank: (ticket: TriageTicket) => number,
): TriageLanes {
  const investigations: TriageTicket[] = [];
  const queue: TriageTicket[] = [];
  const snoozed: TriageTicket[] = [];
  for (const ticket of tickets) {
    if (ticket.snoozedUntilMs != null) snoozed.push(ticket);
    else if (activityRank(ticket) < 2) investigations.push(ticket);
    else queue.push(ticket);
  }
  const compare = (a: TriageTicket, b: TriageTicket) => compareTriageTickets(order, a, b);
  investigations.sort((a, b) => activityRank(a) - activityRank(b) || compare(a, b));
  queue.sort(compare);
  snoozed.sort(
    (a, b) =>
      compareNumber(a.snoozedUntilMs, b.snoozedUntilMs) || compareTriageTickets("attention", a, b),
  );
  return { investigations, queue, snoozed };
}

export function moveTicket(items: TriageTicket[], movedId: string, overId: string) {
  const from = items.findIndex((ticket) => ticket.id === movedId);
  const to = items.findIndex((ticket) => ticket.id === overId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Fractional indexing updates only the moved issue. Linear's sortOrder values
 * are ascending; a generous edge gap avoids creating precision pressure when
 * repeatedly moving an item to the top or bottom. */
export function manualRankAt(items: TriageTicket[], index: number) {
  const previous = index > 0 ? items[index - 1]?.sortOrder : null;
  const next = index + 1 < items.length ? items[index + 1]?.sortOrder : null;
  if (previous != null && next != null) {
    if (previous >= next) return null;
    const midpoint = previous + (next - previous) / 2;
    return midpoint > previous && midpoint < next ? midpoint : null;
  }
  if (previous != null) return previous + 1024;
  if (next != null) return next - 1024;
  return null;
}
