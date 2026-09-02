/**
 * How the command palette finds and orders what you typed.
 *
 * Pure, so the ranking is testable without a dialog: every token of the query
 * has to land somewhere on an item, and where it lands sets the score — an id
 * ("AK-339", typed with or without its dash) outranks a title that merely
 * contains the same letters, a title that *starts* with the word outranks one
 * that has it in the middle, and the project, branch or author behind a row
 * counts only as a tie-break. Groups keep their fixed order; within a group the
 * best match leads.
 */

export interface Searchable {
  /** The short identity a row is known by — a ticket id, a PR number. */
  code?: string;
  label: string;
  /** Trailing context: a project, a repo, a branch. */
  meta?: string;
  /** Matched but never shown: an author, a status, a kind. */
  keywords?: string;
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

const compact = (s: string) => s.toLowerCase().replace(/-/g, "");

/** How well one token lands on one item; 0 when it doesn't. */
function scoreToken(item: Searchable, token: string): number {
  let best = 0;
  if (item.code) {
    const code = compact(item.code);
    const needle = compact(token);
    if (needle && code === needle) best = Math.max(best, 10);
    else if (needle && code.startsWith(needle)) best = Math.max(best, 8);
    else if (needle && code.includes(needle)) best = Math.max(best, 4);
  }
  const label = item.label.toLowerCase();
  const at = label.indexOf(token);
  if (at === 0) best = Math.max(best, 6);
  else if (at > 0 && /[\s\-_/.:([]/.test(label[at - 1] ?? "")) best = Math.max(best, 4);
  else if (at > 0) best = Math.max(best, 2);
  if (best === 0) {
    const rest = `${item.meta ?? ""} ${item.keywords ?? ""}`.toLowerCase();
    if (rest.includes(token)) best = 1;
  }
  return best;
}

/** The item's score for the whole query — every token must land, or it is 0. */
export function scoreItem(item: Searchable, tokens: string[]): number {
  let total = 0;
  for (const token of tokens) {
    const s = scoreToken(item, token);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

export interface RankOptions {
  /** Every group, in the order the list shows them. */
  groupOrder: readonly string[];
  /** Rows per group while a query is typed. */
  perGroup: number;
  /** Rows per group with the box empty — a glance at what's searchable. */
  perGroupIdle: number;
  total: number;
}

/**
 * The rows to show for `query`, grouped in `groupOrder` and capped. With no
 * query, the first few of every group; with one, the best matches of each.
 */
export function rankItems<T extends Searchable & { group: string }>(
  items: T[],
  query: string,
  { groupOrder, perGroup, perGroupIdle, total }: RankOptions,
): T[] {
  const tokens = tokenize(query);
  const byGroup = new Map<string, { item: T; score: number }[]>();
  for (const item of items) {
    const score = tokens.length === 0 ? 1 : scoreItem(item, tokens);
    if (score === 0) continue;
    const bucket = byGroup.get(item.group);
    if (bucket) bucket.push({ item, score });
    else byGroup.set(item.group, [{ item, score }]);
  }
  const cap = tokens.length === 0 ? perGroupIdle : perGroup;
  const out: T[] = [];
  for (const group of groupOrder) {
    const bucket = byGroup.get(group);
    if (!bucket) continue;
    // A stable sort, so equal scores keep the source order (a list's own ranking).
    if (tokens.length > 0) bucket.sort((a, b) => b.score - a.score);
    for (const { item } of bucket.slice(0, cap)) {
      if (out.length >= total) return out;
      out.push(item);
    }
  }
  return out;
}
