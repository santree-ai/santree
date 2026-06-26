/** The terminal tab strip: "All agents" + one tab per worktree. */
import type { CSSProperties } from "react";

import { branchFor } from "../../lib/format";
import { useWorktrees } from "../../lib/queries";
import { activityColor } from "../../theme/colors";
import { useTrees } from "./model";

export function TreeTabs() {
  const { data: worktrees = [] } = useWorktrees();
  const { activeId, scopeAll, setActive, setScopeAll } = useTrees();
  const broadcastCount = worktrees.filter(
    (w) => w.activity === "Running" || w.activity === "Awaiting",
  ).length;

  const allStyle: CSSProperties = scopeAll
    ? { background: "color-mix(in srgb, var(--accent) 9%, transparent)", color: "var(--accent)" }
    : { background: "transparent", color: "#7c7c85" };

  return (
    <div className="flex h-[38px] flex-none items-stretch overflow-x-auto border-b border-line bg-panel">
      <button
        type="button"
        onClick={setScopeAll}
        className="flex cursor-pointer items-center gap-1.5 border-r border-line px-3.5 font-mono text-[11px] whitespace-nowrap"
        style={allStyle}
      >
        ⊞ All agents<span className="text-[9.5px] text-muted-4">{broadcastCount}</span>
      </button>
      {worktrees.map((w) => {
        const active = !scopeAll && w.id === activeId;
        const style: CSSProperties = active
          ? {
              color: "var(--color-fg)",
              background: "var(--color-app)",
              boxShadow: "inset 0 -2px 0 var(--accent)",
            }
          : { color: "#7c7c85", background: "transparent" };
        return (
          <button
            type="button"
            key={w.id}
            onClick={() => setActive(w.id)}
            className="flex cursor-pointer items-center gap-[7px] border-r border-line px-3.5 font-mono text-[11px] whitespace-nowrap"
            style={style}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: activityColor[w.activity] }}
            />
            {branchFor(w.id)}
          </button>
        );
      })}
    </div>
  );
}
