/** The project's "all agents" overview: a grid of worktree cards (the monitoring
 *  surface). Clicking a card drills into that task's terminal/diff. */
import type { Worktree } from "../../bindings";
import { EmptyState } from "../../components/primitives";
import { WorktreeStats } from "../../components/WorktreeStats";
import { activityColor, statusColor } from "../../theme/colors";
import { useTrees } from "./model";

export function AllAgentsView() {
  const { worktrees, setActive } = useTrees();

  if (worktrees.length === 0) {
    return (
      <EmptyState title="No worktrees" subtitle="Start a task from the sidebar to create one." />
    );
  }

  return (
    <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3.5">
      {worktrees.map((w) => (
        <AgentCard key={w.id} worktree={w} onClick={() => setActive(w.id)} />
      ))}
    </div>
  );
}

function AgentCard({ worktree: w, onClick }: { worktree: Worktree; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer flex-col gap-2.5 rounded-[10px] border border-line-2 bg-deep p-3.5 text-left transition-colors hover:border-line-strong"
    >
      <div className="flex items-center gap-[7px]">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{
            background: activityColor[w.activity],
            boxShadow: `0 0 7px ${activityColor[w.activity]}`,
          }}
        />
        <span className="flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-fg-2">
          {w.branch}
        </span>
        <span className="font-mono text-[9.5px]" style={{ color: activityColor[w.activity] }}>
          {w.activity.toLowerCase()}
        </span>
      </div>
      <div className="line-clamp-2 text-[12.5px] leading-[1.35] text-muted">{w.title}</div>
      <div className="mt-auto flex items-center gap-2.5 font-mono text-[10px] text-muted-4">
        <span className="flex items-center gap-1">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: statusColor[w.status] }}
          />
          {w.status}
        </span>
        <WorktreeStats worktree={w} />
      </div>
    </button>
  );
}
