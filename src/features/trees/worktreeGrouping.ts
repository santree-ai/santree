/** Pure ordering rules for a list of worktrees: given the worktrees of one group,
 *  put a stacked worktree directly under the one it branched off and say how deep
 *  to indent it. No rendering and no data fetching, so any surface that lists
 *  worktrees can share the same nesting. */
import type { Worktree } from "../../bindings";

/** Deepest level that still indents. A longer chain keeps its order but stops
 *  stepping in, so a tall stack can't starve the text column of the rows at the
 *  bottom of it — which is what a sidebar only a few hundred pixels wide would
 *  otherwise do. Shared with the surfaces that render the nesting. */
export const MAX_DEPTH = 3;

/**
 * Order one project's worktrees so a stacked one sits directly under the worktree
 * it branched off, with the depth to indent it by.
 *
 * A worktree's parent is the one whose branch it uses as its base — the same fact
 * the bottom bar's base chip shows. The lookup is per group, so a parent in another
 * project simply isn't found and the child renders flat rather than being dragged
 * out of its own band. Roots (and siblings) keep the list's original order.
 *
 * Exported for testing — see worktreeGrouping.test.ts.
 */
export function stackWorktrees(list: Worktree[]): { worktree: Worktree; depth: number }[] {
  // Pending placeholders have no branch yet; an empty key would make them each
  // other's parents.
  const byBranch = new Map<string, Worktree>();
  for (const w of list) if (w.branch) byBranch.set(w.branch, w);

  const childrenOf = new Map<string, Worktree[]>();
  const roots: Worktree[] = [];
  for (const w of list) {
    const parent = w.baseBranch ? byBranch.get(w.baseBranch) : undefined;
    if (!parent || parent.id === w.id) {
      roots.push(w);
      continue;
    }
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), w]);
  }

  const out: { worktree: Worktree; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (w: Worktree, depth: number) => {
    if (seen.has(w.id)) return; // a cycle would otherwise recurse forever
    seen.add(w.id);
    out.push({ worktree: w, depth: Math.min(depth, MAX_DEPTH) });
    for (const child of childrenOf.get(w.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Only reachable if the base branches form a cycle — every worktree still has to
  // render, so fall back to a flat row rather than dropping it from the list.
  for (const w of list) {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      out.push({ worktree: w, depth: 0 });
    }
  }
  return out;
}
