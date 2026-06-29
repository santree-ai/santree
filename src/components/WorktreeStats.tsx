/** The shared git-stat footer for a worktree (+adds / −dels / ahead / behind /
 *  dirty) — used by the Trees sidebar/all-agents card and the Issues right panel
 *  so the row can't drift between surfaces. Renders bare spans; the caller owns
 *  the flex/typography wrapper. */
import type { Worktree } from "../bindings";

export function WorktreeStats({
  worktree: w,
  showClean = false,
}: {
  worktree: Worktree;
  /** Show a "clean" label when there are no uncommitted changes (sidebar entry). */
  showClean?: boolean;
}) {
  return (
    <>
      <span className="text-status-green">+{w.addLines}</span>
      <span className="text-status-red">−{w.delLines}</span>
      {w.ahead > 0 && <span>↑{w.ahead}</span>}
      {w.behind > 0 && <span className="text-status-amber">↓{w.behind}</span>}
      {w.dirty ? (
        <span className="text-status-amber">● uncommitted</span>
      ) : showClean ? (
        <span>clean</span>
      ) : null}
    </>
  );
}
