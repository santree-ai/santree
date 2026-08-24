/**
 * How the Reviews sidebar decides what to show first.
 *
 * Pure functions over `ReviewPr`, kept out of the component so the rules that
 * actually drive the inbox — what "waiting on you" means, how long something has
 * waited, how big a review is — are testable and stated once.
 *
 * The organizing idea is that a review inbox is only useful if it answers "what
 * should I pick up next?". That's three signals, in priority order:
 *   1. **Is it mine to act on?** A direct request outranks a team request, and a PR
 *      you've already reviewed drops out until the author pushes again.
 *   2. **How long has it waited?** Measured from `waitingSince` (when *you* were
 *      asked), not from the PR's last update — a busy PR isn't a fresh one.
 *   3. **How big is it?** So a ten-minute gap can be spent on something finishable.
 */
import type { ReviewPr, TicketRef } from "../../bindings";

/** How the sidebar's rows are bucketed into sections. */
export type Grouping = "category" | "project" | "repo";

/** What orders rows within a section. */
export type SortMode = "waiting" | "updated" | "size";

/** Whether a PR is still the viewer's to act on, or already had their verdict. */
export type ReviewStance = "waiting-on-you" | "reviewed";

/**
 * Where a PR sits in the viewer's review queue.
 *
 * `reviewed` is deliberately *not* sticky: a review you left before the author
 * pushed again is a review of code that no longer exists, so new commits move the
 * PR back to "waiting on you". Comparing against the head commit's date (rather
 * than the PR's `updatedAt`) is what makes that honest — a comment, a label, or a
 * CI re-run all bump `updatedAt` without changing a line of code.
 */
export function stanceOf(pr: ReviewPr): ReviewStance {
  if (!pr.viewerReview) return "waiting-on-you";
  return pr.headCommittedAt > pr.viewerReview.submittedAt ? "waiting-on-you" : "reviewed";
}

/** Split a list into the PRs still waiting on the viewer and the ones they've
 *  already reviewed, preserving order within each. */
export function splitByStance(prs: ReviewPr[]): { waiting: ReviewPr[]; reviewed: ReviewPr[] } {
  const waiting: ReviewPr[] = [];
  const reviewed: ReviewPr[] = [];
  for (const pr of prs) (stanceOf(pr) === "reviewed" ? reviewed : waiting).push(pr);
  return { waiting, reviewed };
}

/** Whole days a PR has been waiting on the viewer, floored. `now` is injected so
 *  this stays pure (and testable without freezing the clock). */
export function waitingDays(pr: ReviewPr, now: number = Date.now()): number {
  const since = Date.parse(pr.waitingSince);
  // An unparseable timestamp must not read as "waiting since 1970" and rocket to
  // the top of the queue — treat it as brand new instead.
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 86_400_000));
}

/** Human age for the row chip: "today", "1d", "6d", "3w". */
export function waitingLabel(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** Review-effort t-shirt size, from the diff and how far it's spread. A 400-line
 *  change in one file reviews faster than 400 lines across thirty, so file count
 *  carries weight of its own rather than being a tiebreak. */
export type PrSize = "XS" | "S" | "M" | "L" | "XL";

export function sizeOf(pr: ReviewPr): PrSize {
  const score = pr.additions + pr.deletions + pr.changedFiles * 20;
  if (score < 50) return "XS";
  if (score < 200) return "S";
  if (score < 600) return "M";
  if (score < 1500) return "L";
  return "XL";
}

/** Comparators for the sort control. All are total orders (ties break on PR id)
 *  so the list can't shuffle between refetches of identical data. */
const COMPARATORS: Record<SortMode, (a: ReviewPr, b: ReviewPr) => number> = {
  // Oldest wait first — the whole point of the sort.
  waiting: (a, b) => a.waitingSince.localeCompare(b.waitingSince) || a.id.localeCompare(b.id),
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  size: (a, b) => {
    const score = (p: ReviewPr) => p.additions + p.deletions + p.changedFiles * 20;
    return score(a) - score(b) || a.id.localeCompare(b.id);
  },
};

export function sortPrs(prs: ReviewPr[], mode: SortMode): ReviewPr[] {
  return [...prs].sort(COMPARATORS[mode]);
}

/** One rendered block of the sidebar. */
export interface PrGroup {
  /** Stable key + heading. */
  key: string;
  label: string;
  prs: ReviewPr[];
  /** Project color/icon, when grouping by project. */
  color?: string | null;
  icon?: string | null;
  targetDate?: string | null;
}

/** Short "name" from an "owner/name" slug. */
export function repoName(slug: string): string {
  return slug.split("/").pop() ?? slug;
}

/**
 * Group a flat PR list for the project/repo groupings.
 *
 * `ticketProject` maps a PR to its Linear project; PRs with no ticket (or whose
 * ticket Linear didn't return) land in a trailing "No project" block rather than
 * being dropped — an inbox that silently hides rows is worse than an untidy one.
 * Groups are ordered by their most-waiting member so the same "oldest first"
 * question the sort answers within a block is also answered between blocks.
 */
export function groupPrs(
  prs: ReviewPr[],
  by: Exclude<Grouping, "category">,
  sort: SortMode,
  ticketFor: (pr: ReviewPr) => TicketRef | undefined,
): PrGroup[] {
  const groups = new Map<string, PrGroup>();
  for (const pr of prs) {
    const ticket = by === "project" ? ticketFor(pr) : undefined;
    const key = by === "repo" ? pr.repo : (ticket?.project ?? NO_PROJECT);
    const existing = groups.get(key);
    if (existing) {
      existing.prs.push(pr);
      continue;
    }
    groups.set(key, {
      key,
      label: by === "repo" ? repoName(key) : key,
      prs: [pr],
      color: ticket?.projectColor,
      icon: ticket?.projectIcon,
      targetDate: ticket?.projectTargetDate,
    });
  }

  const ordered = [...groups.values()];
  for (const g of ordered) g.prs = sortPrs(g.prs, sort);
  ordered.sort((a, b) => {
    // The catch-all always sinks, however old its contents.
    if (a.key === NO_PROJECT) return 1;
    if (b.key === NO_PROJECT) return -1;
    return COMPARATORS[sort](a.prs[0], b.prs[0]) || a.label.localeCompare(b.label);
  });
  return ordered;
}

/** Heading for PRs whose ticket carries no project (or that have no ticket). */
export const NO_PROJECT = "No project";
