/** Left rail of the Trees tab: the list of agent worktrees. */
import type { CSSProperties } from "react";

import { Dot } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { branchFor } from "../../lib/format";
import { useWorktrees } from "../../lib/queries";
import { activityColor, statusColor } from "../../theme/colors";
import { useTrees } from "./model";

export function WorktreeSidebar() {
  const { data: worktrees = [] } = useWorktrees();
  const { activeId, scopeAll, setActive } = useTrees();

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <span className="text-[12px] font-semibold text-fg-2">Worktrees</span>
        <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10.5px] text-muted-2">
          {worktrees.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {worktrees.map((w) => {
          const active = !scopeAll && w.id === activeId;
          const style: CSSProperties = {
            border: `1px solid ${active ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "transparent"}`,
            background: active
              ? "color-mix(in srgb, var(--accent) 6%, transparent)"
              : "transparent",
          };
          return (
            <button
              type="button"
              key={w.id}
              onClick={() => setActive(w.id)}
              className="mb-[5px] w-full cursor-pointer rounded-[9px] px-[11px] py-2.5 text-left transition-colors hover:bg-hover"
              style={style}
            >
              <div className="mb-[5px] flex items-center gap-2">
                <Dot color={statusColor[w.status]} size={7} glow />
                <span className="flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-fg-2">
                  {branchFor(w.id)}
                </span>
                <span
                  className="font-mono text-[9.5px]"
                  style={{ color: activityColor[w.activity] }}
                >
                  {w.activity.toLowerCase()}
                </span>
              </div>
              <div className="mb-1.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-muted">
                {w.title}
              </div>
              <div className="flex items-center gap-2.5 font-mono text-[10px] text-muted-4">
                <span className="text-status-green">+{w.addLines}</span>
                <span className="text-status-red">−{w.delLines}</span>
                <span>↑{w.ahead}</span>
                {w.dirty ? (
                  <span className="text-status-amber">● uncommitted</span>
                ) : (
                  <span>clean</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <SidebarFooter />
    </>
  );
}
