/**
 * Two rules the review surfaces share: which PRs of an inbox belong to one
 * project, and how a chain of stacked PRs hangs together.
 *
 * Pure functions over `ReviewPr`, kept out of the components so they are
 * testable and stated once. This was once the whole judgement layer behind a
 * review inbox — "does this still need you", "how long has it waited". Those
 * moved out in two steps: the inbox's *shape* to `reviewGroupsByProject` in
 * `lib/queries.ts` when the app sidebar became the one place PRs are listed, and
 * the per-PR verdicts with the landing page that was their last caller.
 */
import type { ReviewInbox, ReviewPr } from "../../bindings";

export interface StackedPr {
  pr: ReviewPr;
  depth: number;
}

/**
 * The same inbox, holding only the PRs of one registered project.
 *
 * `project` is matched exactly, `null` included — which is how a PR from a repo
 * you never cloned keeps its own scope rather than joining a leftover pile.
 * A team left with nothing drops out entirely, so a section can't render as an
 * empty heading.
 */
export function inboxOfProject(inbox: ReviewInbox, project: string | null): ReviewInbox {
  const mine = (prs: ReviewPr[]) => prs.filter((pr) => pr.project === project);
  return {
    ...inbox,
    mine: mine(inbox.mine),
    requested: mine(inbox.requested),
    teams: inbox.teams
      .map((team) => ({ ...team, prs: mine(team.prs) }))
      .filter((team) => team.prs.length > 0),
  };
}

/** Put a stacked PR immediately below the PR whose head ref is its base ref.
 * Stable GitHub ref node ids avoid false links between same-named fork branches. */
export function stackPrs(prs: ReviewPr[], maxDepth = 3): StackedPr[] {
  const byHeadRef = new Map<string, ReviewPr>();
  for (const pr of prs) if (pr.headRefId) byHeadRef.set(pr.headRefId, pr);

  const children = new Map<string, ReviewPr[]>();
  const roots: ReviewPr[] = [];
  for (const pr of prs) {
    const parent = pr.baseRefId ? byHeadRef.get(pr.baseRefId) : undefined;
    if (!parent || parent.id === pr.id) {
      roots.push(pr);
      continue;
    }
    children.set(parent.id, [...(children.get(parent.id) ?? []), pr]);
  }

  const stacked: StackedPr[] = [];
  const seen = new Set<string>();
  const walk = (pr: ReviewPr, depth: number) => {
    if (seen.has(pr.id)) return;
    seen.add(pr.id);
    stacked.push({ pr, depth: Math.min(depth, maxDepth) });
    for (const child of children.get(pr.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Cycles or malformed duplicate identities must never make a PR disappear.
  for (const pr of prs) if (!seen.has(pr.id)) stacked.push({ pr, depth: 0 });
  return stacked;
}

/**
 * Which vertical rules each stacked row's connector draws — the rule a file
 * tree follows, for the reason a file tree follows it.
 *
 * Every row used to draw a rule at each of its ancestor columns, full height,
 * and a half-height one at its own. In a chain (the ordinary stack: B on A, C on
 * B) that renders a line down the *last* child's column even though nothing else
 * hangs off it, and stops the parent's own rule at the elbow — so the guide
 * broke and restarted with a gap between, which is what reads as cut.
 *
 * The rule instead: a column is drawn on this row only while the branch that
 * owns it still has something below. Column `k` belongs to the ancestor at depth
 * `k`, and it survives past this row only if a further child of that ancestor
 * comes later — which, walking the flattened pre-order list backwards, is one
 * boolean per column.
 *
 * Returned per row as `guides[k]`: "the rule at column k continues below this
 * row". The row's own column (`k === depth - 1`) is the elbow's: false is the
 * last child's `└`, true the `├` of one with a sibling still to come.
 */
export function stackGuides(rows: StackedPr[]): boolean[][] {
  const guides: boolean[][] = Array.from({ length: rows.length });
  // Per column: does anything below the row being visited still hang off it?
  const alive: boolean[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const depth = rows[i].depth;
    guides[i] = Array.from({ length: depth }, (_, k) => alive[k] ?? false);
    // This row is itself a child of column `depth - 1`, so that column reaches
    // at least this far; and being at `depth` it closes every deeper column,
    // whose branch cannot continue past a row shallower than it.
    for (let k = depth; k < alive.length; k++) alive[k] = false;
    if (depth > 0) alive[depth - 1] = true;
  }
  return guides;
}
