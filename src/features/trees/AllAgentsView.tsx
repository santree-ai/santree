/** The project's "all agents" overview: a grid of worktree cards (the monitoring
 *  surface). Clicking a card drills into that task's terminal/diff. */
import type { SessionState, Worktree } from "../../bindings";
import { EmptyState } from "../../components/primitives";
import { WorktreeStats } from "../../components/WorktreeStats";
import { useSessionByPath } from "../../lib/queries";
import { palette, sessionStateMeta, statusColor, statusLabel } from "../../theme/colors";
import { effectiveSessionState, useTrees } from "./model";

export function AllAgentsView() {
  const { worktrees, setActive } = useTrees();

  // Live Claude session state per worktree, correlated by cwd (the worktree path
  // Claude ran in) — the real "what is the agent doing" signal.
  const sessionByPath = useSessionByPath();

  if (worktrees.length === 0) {
    return (
      <EmptyState title="No worktrees" subtitle="Start a task from the sidebar to create one." />
    );
  }

  return (
    <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3.5">
      {worktrees.map((w) => (
        <AgentCard
          key={w.id}
          worktree={w}
          sessionState={sessionByPath.get(w.path)}
          onClick={() => setActive(w.id)}
        />
      ))}
    </div>
  );
}

function AgentCard({
  worktree: w,
  sessionState,
  onClick,
}: {
  worktree: Worktree;
  sessionState: SessionState | undefined;
  onClick: () => void;
}) {
  // The real state, reconciled with liveness (not running → "exited"). `null`
  // means nothing to show (never launched / a live terminal with no agent state).
  const state = effectiveSessionState(w, sessionState);
  const meta = state ? sessionStateMeta[state] : undefined;
  const color = meta?.color ?? palette.muted;
  const label = meta?.short ?? "—";
  const hint =
    (state === "waiting" || state === "permission") && sessionState?.message
      ? `${meta?.label}: ${sessionState.message}`
      : meta?.label;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex cursor-pointer flex-col gap-2.5 rounded-[10px] border border-line-2 bg-deep p-3.5 text-left transition-colors hover:border-line-strong"
    >
      <div className="flex items-center gap-[7px]" title={hint}>
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{ background: color, boxShadow: `0 0 7px ${color}` }}
        />
        <span className="flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-fg-2">
          {w.branch}
        </span>
        <span className="font-mono text-[9.5px]" style={{ color }}>
          {label}
        </span>
      </div>
      <div className="line-clamp-2 text-[12.5px] leading-[1.35] text-muted">{w.title}</div>
      <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-muted-4">
        {/* No linked ticket status (not assigned to the viewer, or the base entry)
            ⇒ no chip. Better than a confident, meaningless one. */}
        {w.status && (
          <span className="flex items-center gap-1">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: statusColor[w.status] }}
            />
            {statusLabel[w.status]}
          </span>
        )}
        <WorktreeStats worktree={w} />
      </div>
    </button>
  );
}
