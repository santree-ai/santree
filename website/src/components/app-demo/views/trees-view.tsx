import { CodexLogo } from "~/components/icons";
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
import {
  BranchGlyph,
  ContextBar,
  DiffStat,
  PanelGlyph,
  PlusGlyph,
  PrChip,
  PushGlyph,
  SESSION_STATE_META,
  SelectBox,
  StatusDot,
} from "../widgets";

/** The hero view: worktree sidebar + live Codex terminal, laid out like the
 * real TreesView — cards carry the select box, session dot + ticket + PR
 * chip, the title, then the state word + git stats. */

function WorktreeCard({ wt }: { wt: DemoWorktree }) {
  const merged = wt.state === "merged";
  const session = merged ? null : SESSION_STATE_META[wt.state];
  return (
    <div className="flex items-stretch">
      {/* Elbow connector for a stacked worktree: spine + tick into the card. */}
      {wt.depth === 1 && (
        <span className="relative w-3.5 shrink-0" aria-hidden>
          <span className="absolute left-0 top-0 h-1/2 border-l border-line-2" />
          <span className="absolute left-0 top-1/2 w-3.5 border-t border-line-2" />
        </span>
      )}
      <div
        className={`flex min-w-0 flex-1 gap-2 rounded-[9px] px-[11px] py-2.5 ${merged ? "opacity-55" : ""}`}
        style={{
          border: `1px solid ${wt.active ? "color-mix(in srgb, var(--color-accent) 40%, transparent)" : "var(--color-line-2)"}`,
          background: wt.active
            ? "color-mix(in srgb, var(--color-accent) 6%, transparent)"
            : "transparent",
        }}
      >
        <span className="mt-px">
          <SelectBox />
        </span>
        <div className="min-w-0 flex-1">
          <div className="mb-[5px] flex items-center gap-1.5">
            {session && <StatusDot state={wt.state} />}
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg/90">
              {wt.ticket}
            </span>
            {wt.pr && <PrChip num={wt.pr.num} state={wt.pr.state} />}
          </div>
          <div className="mb-1.5 truncate text-[11.5px] leading-[1.3] text-muted">{wt.title}</div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-muted-4">
            {session && <span style={{ color: session.color }}>{session.label}</span>}
            <DiffStat add={wt.add} del={wt.del} />
            {wt.ahead !== undefined && <span>↑{wt.ahead}</span>}
            {wt.dirty ? (
              <span className="text-status-amber">● uncommitted</span>
            ) : (
              <span>clean</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="text-[12px] font-semibold text-fg/90">Worktrees</span>
        <span className="rounded-[5px] border border-line-2 bg-white/4 px-1.5 py-px font-mono text-[10.5px] tabular-nums text-muted-2">
          {WORKTREES.length + 1}
        </span>
        <span className="flex-1" />
        <span className="flex size-6 items-center justify-center rounded-md border border-line-2 bg-white/3 text-muted-2">
          <PlusGlyph size={12} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {/* Base entry */}
        <div className="mb-1 flex items-center gap-2 rounded-[9px] px-[11px] py-2 text-[12px] text-muted-2">
          <BranchGlyph size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">main</span>
          <span className="flex items-center gap-1 font-mono text-[10px] text-status-amber">
            ↓2
          </span>
        </div>
        <div className="px-2 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-4">
          santree
        </div>
        <div className="flex flex-col gap-[5px]">
          {WORKTREES.map((wt) => (
            <WorktreeCard key={wt.ticket} wt={wt} />
          ))}
        </div>
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
      sidebar={<Sidebar />}
      main={
        <>
          {/* Main tab bar: Issue · Terminal (spark = an agent session lives
              there) · the "+" tab, accent-underlined like the real app. */}
          <div className="flex h-9 shrink-0 items-stretch border-b border-hairline bg-black/20 text-[11px]">
            <span className="flex items-center px-3 text-muted-2">Issue</span>
            <span
              className="flex items-center gap-1.5 px-3 font-medium text-fg"
              style={{ boxShadow: "inset 0 -2px 0 var(--color-accent)" }}
            >
              <CodexLogo size={10} className="text-accent" />
              Codex
            </span>
            <span className="flex items-center px-2.5 text-muted-4">
              <PlusGlyph size={11} />
            </span>
          </div>
          <Terminal live={live} />
          {/* Session status line: model · context fill · cost, like the app's
              SessionStatusLine. */}
          <div className="flex shrink-0 items-center gap-2.5 border-t border-hairline bg-black/20 px-3 py-1.5">
            <span className="font-mono text-[10px] text-fg/70">{SESSION_STATUS.model}</span>
            <ContextBar pct={SESSION_STATUS.contextPct} />
            <span className="font-mono text-[10px] tabular-nums text-status-green">
              {SESSION_STATUS.contextPct}%
            </span>
            <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-4">
              {SESSION_STATUS.cost}
            </span>
          </div>
          {/* Bottom bar: git state · base chip │ push / PR / files. */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-t border-hairline bg-black/25 px-2 text-[11px] text-muted-2">
            <span className="flex items-center gap-1.5 px-1 font-mono text-status-amber">
              ● uncommitted
            </span>
            <span className="mx-0.5 h-3.5 w-px bg-white/8" />
            <span className="flex items-center gap-1.5 rounded px-2 py-0.5 font-mono">
              <BranchGlyph size={11} />
              {BOTTOM_BAR.base}
              <span className="text-status-green">↑{BOTTOM_BAR.ahead}</span>
            </span>
            <span className="flex-1" />
            <span className="flex items-center gap-1.5 rounded px-2 py-0.5">
              <PushGlyph size={11} />
              Push {BOTTOM_BAR.push}
            </span>
            <span className="flex items-center gap-1.5 rounded px-2 py-0.5">Create PR</span>
            <span className="mx-0.5 h-3.5 w-px bg-white/8" />
            <span className="flex items-center gap-1.5 rounded px-2 py-0.5 text-accent">
              <PanelGlyph size={11} />
              Files
            </span>
          </div>
        </>
      }
    />
  );
}
