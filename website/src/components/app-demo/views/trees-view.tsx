import { ViewShell } from "../chrome";
import {
  BOTTOM_BAR,
  type DemoWorktree,
  SESSION_STATUS,
  TERM_LIVE,
  TERM_PRESEEDED,
  WORKTREES,
} from "../data";
import { TermLine, Typewriter } from "../typewriter";
import { AsciiSpinner, ContextBar, DiffStat, ElapsedClock, PrChip, StatusDot } from "../widgets";

/** The hero view: worktree sidebar + live Claude terminal. */

function WorktreeCard({ wt, live }: { wt: DemoWorktree; live: boolean }) {
  return (
    <div className={wt.depth === 1 ? "relative ml-3.5 pl-3" : "relative"}>
      {/* Elbow connector for a stacked branch: child branches off its blocker. */}
      {wt.depth === 1 && (
        <span
          className="absolute -top-1.5 bottom-1/2 left-0 w-3 rounded-bl-md border-b border-l border-line"
          aria-hidden
        />
      )}
      <div
        className={`rounded-lg border px-2.5 py-2 ${
          wt.active ? "border-line-2 bg-white/5" : "border-hairline bg-white/2"
        } ${wt.state === "merged" ? "opacity-55" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusDot state={wt.state} />
          <span className="shrink-0 whitespace-nowrap font-mono text-[9px] text-muted-2">
            {wt.ticket}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg/90">{wt.title}</span>
        </div>
        <div className="mt-1 truncate font-mono text-[9px] text-muted-4">{wt.branch}</div>
        <div className="mt-1.5 flex items-center gap-2">
          {wt.state === "running" && live && (
            <AsciiSpinner className="text-[9px] text-status-green" />
          )}
          <DiffStat add={wt.add} del={wt.del} />
          {wt.ahead !== undefined && (
            <span className="font-mono text-[9px] text-muted-2">↑{wt.ahead}</span>
          )}
          {wt.pr && <PrChip num={wt.pr.num} state={wt.pr.state} />}
          {wt.clockBaseSec !== undefined && (
            <span className="ml-auto">
              <ElapsedClock baseSec={wt.clockBaseSec} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ live }: { live: boolean }) {
  return (
    <>
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
        <span className="text-[11px] font-medium text-fg">Worktrees</span>
        <span className="rounded-full bg-white/6 px-1.5 font-mono text-[9px] tabular-nums text-muted-2">
          {WORKTREES.length + 1}
        </span>
        <span className="ml-auto rounded-md border border-hairline bg-white/3 px-1.5 py-0.5 text-[9px] text-muted">
          + Start task
        </span>
      </div>
      {/* Base entry */}
      <div className="mx-2 flex items-center gap-1.5 rounded-md px-1.5 py-1.5">
        <span className="font-mono text-[10px] text-muted">main</span>
        <span className="font-mono text-[9px] text-status-amber">↓2</span>
        <span className="ml-auto font-mono text-[9px] text-muted-4">base</span>
      </div>
      <div className="mx-3 mb-1.5 mt-2 font-mono text-[8px] uppercase tracking-[0.14em] text-muted-4">
        santree
      </div>
      <div className="flex flex-col gap-1.5 px-2">
        {WORKTREES.map((wt) => (
          <WorktreeCard key={wt.ticket} wt={wt} live={live} />
        ))}
      </div>
    </>
  );
}

function Terminal({ live }: { live: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-hidden bg-app/80 px-4 py-3 font-mono text-[11px] leading-[1.55]">
      {TERM_PRESEEDED.map((event) =>
        event.kind === "pause" ? null : <TermLine key={event.text} event={event} />,
      )}
      <Typewriter live={TERM_LIVE} active={live} />
    </div>
  );
}

export function TreesView({ live }: { live: boolean }) {
  return (
    <ViewShell
      sidebar={<Sidebar live={live} />}
      main={
        <>
          {/* Main tab bar */}
          <div className="flex shrink-0 items-center gap-0.5 border-b border-hairline px-2 py-1.5">
            <span className="rounded-md bg-white/6 px-2.5 py-1 text-[10px] text-fg">Terminal</span>
            <span className="px-2.5 py-1 text-[10px] text-muted-2">Issue</span>
            <span className="px-1.5 text-[10px] text-muted-4">+</span>
            <span className="ml-auto font-mono text-[9px] text-muted-4">SAN-142</span>
          </div>
          <Terminal live={live} />
          {/* Session status line */}
          <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-1.5">
            <span className="font-mono text-[9px] text-muted-2">{SESSION_STATUS.model}</span>
            <ContextBar pct={SESSION_STATUS.contextPct} />
            <span className="font-mono text-[9px] tabular-nums text-muted-2">
              {SESSION_STATUS.contextPct}%
            </span>
            <span className="ml-auto font-mono text-[9px] tabular-nums text-muted-2">
              {SESSION_STATUS.cost}
            </span>
          </div>
          {/* Bottom bar */}
          <div className="flex h-8 shrink-0 items-center gap-2.5 border-t border-hairline px-3">
            <span className="truncate font-mono text-[9px] text-muted-2">{BOTTOM_BAR.branch}</span>
            <DiffStat add={BOTTOM_BAR.add} del={BOTTOM_BAR.del} />
            {BOTTOM_BAR.uncommitted && (
              <span className="flex items-center gap-1 font-mono text-[9px] text-status-amber">
                <span className="size-1 rounded-full bg-current" /> uncommitted
              </span>
            )}
            <span className="ml-auto flex gap-1.5">
              <span className="size-3 rounded border border-hairline bg-white/4" />
              <span className="size-3 rounded border border-hairline bg-white/4" />
            </span>
          </div>
        </>
      }
    />
  );
}
