/**
 * How much of the machine santree's agents are using, and where.
 *
 * The bar shows one number — total resident memory — because that is the one
 * that decides whether the laptop is about to swap. The popover is the resource
 * manager: every process santree's terminals own, grouped repo → worktree →
 * terminal, with CPU and memory beside each, and santree's own processes as
 * their own row so the total is honest. Sampling costs a `ps` sweep, so it only
 * runs while the popover is open.
 *
 * Both figures are approximations that the backend deliberately ships raw (see
 * `resources.rs`), so presenting them honestly is this file's job: CPU is
 * divided by the machine's core count — otherwise a busy agent tree reads
 * "812.5%" and looks broken — and both totals carry the caveat that makes them
 * interpretable, on-screen as well as on hover.
 */
import { useState } from "react";

import type { RepoUsage, TerminalUsage, WorktreeUsage } from "../../../bindings";
import { formatBytes } from "../../../lib/format";
import { useResourceUsage } from "../../../lib/queries";
import { shortRepoName } from "../../../lib/repoName";
import { ChevronDownIcon, ChevronRightIcon, MemoryIcon, RefreshIcon } from "../../icons";
import { Dropdown, ListSkeleton } from "../../primitives";
import { StatusButton } from "./StatusSegment";

/**
 * CPU as a share of the whole machine.
 *
 * The backend ships `ps`'s number, which is percent of *one* core — so a busy
 * agent tree sums to "812.5%", a figure that reads as impossible until you know
 * the ceiling on a 14-core box is 1400%. Dividing by the core count is the
 * entire fix: every row and the total are then on a 0-100 scale a person can
 * act on. Sub-0.1% is shown as such rather than rounded to `0.0%`, or a tree of
 * idle-but-alive helpers looks like a tree of dead ones.
 */
function pct(value: number | null, cores: number): string {
  const share = (value ?? 0) / Math.max(1, cores);
  if (share <= 0) return "0%";
  return share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
}

/** What each column actually measures — shown on hover, and read out by the
 *  `sr-only` copy beside the figures so a tooltip is never the only route. */
const CPU_HELP =
  "Share of all logical cores on this machine. ps averages each process over its own lifetime, so one that was busy a moment ago still reads high.";
const RSS_HELP =
  "Summed resident set size. A page shared between processes, such as a library or a forked child's heap, is resident in each of them, so the total runs high.";

/** One line of the tree: label, then CPU and memory in fixed columns. */
function Row({
  depth,
  label,
  cpu,
  rss,
  cores,
  dot,
  strong = false,
  chevron,
  onToggle,
}: {
  depth: number;
  label: string;
  cpu: number | null;
  rss: number | null;
  /** The denominator `cpu` is rendered against — see {@link pct}. */
  cores: number;
  /** A live marker for a terminal row; absent on group rows. */
  dot?: boolean;
  strong?: boolean;
  chevron?: boolean;
  onToggle?: () => void;
}) {
  const Chevron = chevron ? ChevronDownIcon : ChevronRightIcon;
  const inner = (
    <>
      {onToggle ? (
        <Chevron size={9} className="flex-none text-muted-4" />
      ) : (
        <span className="w-[9px] flex-none" />
      )}
      {dot !== undefined && (
        <span
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: dot ? "var(--color-status-green)" : "var(--color-dot)" }}
        />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${strong ? "font-mono text-[10px] tracking-[.06em] text-muted-3 uppercase" : "text-[11.5px] text-fg-2"}`}
        title={label}
      >
        {label}
      </span>
      <span className="w-12 flex-none text-right font-mono text-[10.5px] text-muted-3 tabular-nums">
        {pct(cpu, cores)}
      </span>
      <span className="w-[68px] flex-none text-right font-mono text-[10.5px] text-muted-3 tabular-nums">
        {formatBytes(rss)}
      </span>
    </>
  );
  const className = "flex h-7 w-full items-center gap-1.5 rounded pr-2 text-left";
  const style = { paddingLeft: 8 + depth * 14 };
  if (onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className={`${className} cursor-pointer hover:bg-hover`}
        style={style}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={className} style={style}>
      {inner}
    </div>
  );
}

function TerminalRow({ t, depth, cores }: { t: TerminalUsage; depth: number; cores: number }) {
  return (
    <Row depth={depth} label={t.label} cpu={t.cpuPct} rss={t.rssBytes} cores={cores} dot={t.live} />
  );
}

function WorktreeRows({ w, depth, cores }: { w: WorktreeUsage; depth: number; cores: number }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Row
        depth={depth}
        label={w.label}
        cpu={w.cpuPct}
        rss={w.rssBytes}
        cores={cores}
        chevron={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open &&
        w.terminals.map((t) => <TerminalRow key={t.pid} t={t} depth={depth + 1} cores={cores} />)}
    </>
  );
}

function RepoRows({ r, cores }: { r: RepoUsage; cores: number }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Row
        depth={0}
        label={shortRepoName(r.repo)}
        cpu={r.cpuPct}
        rss={r.rssBytes}
        cores={cores}
        strong
        chevron={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && r.worktrees.map((w) => <WorktreeRows key={w.id} w={w} depth={1} cores={cores} />)}
    </>
  );
}

export function ResourceSegment() {
  const [open, setOpen] = useState(false);
  // Sampled every 30s for the bar's total, every 4s while the popover is open —
  // a `ps` sweep every few seconds for a tree nobody is looking at is waste.
  const usage = useResourceUsage(open);
  const total = usage.data?.totalRssBytes ?? null;
  // Never 0 from the backend, but a stale/absent snapshot must not divide by it.
  const cores = Math.max(1, usage.data?.coreCount ?? 1);

  return (
    <Dropdown
      placement="up"
      align="right"
      open={open}
      onOpenChange={setOpen}
      menuClassName="w-[400px] overflow-hidden p-0"
      trigger={(toggle) => (
        <StatusButton onClick={toggle} title="Resource manager" aria-label="Resource manager">
          <MemoryIcon size={11} />
          <span className="tabular-nums">{total === null ? "—" : formatBytes(total)}</span>
        </StatusButton>
      )}
    >
      {() => (
        <div className="flex max-h-[420px] flex-col">
          <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-2">
            <MemoryIcon size={12} className="text-muted-3" />
            <span className="text-[12px] font-semibold text-fg">Resource manager</span>
            <button
              type="button"
              onClick={() => void usage.refetch()}
              aria-busy={usage.isFetching}
              aria-label="Refresh"
              title="Refresh"
              className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-4 hover:bg-hover hover:text-fg-2"
            >
              <RefreshIcon size={11} className={usage.isFetching ? "animate-spin" : ""} />
            </button>
          </div>
          {usage.data && (
            <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-[11px] tabular-nums">
              {/* The core count is on-screen, not just in the tooltip: it is the
                  denominator, and without it the percentage means nothing. */}
              <span className="flex-none text-fg-2" title={CPU_HELP}>
                {pct(usage.data.totalCpuPct, cores)}
              </span>
              <span className="flex-none text-[10px] text-muted-4" title={CPU_HELP}>
                of {cores} cores
              </span>
              <span className="sr-only">{CPU_HELP}</span>
              <span className="ml-1 flex-none text-fg-2" title={RSS_HELP}>
                {formatBytes(usage.data.totalRssBytes)}
              </span>
              <span className="flex-none text-[10px] text-muted-4" title={RSS_HELP}>
                Σ RSS
              </span>
              <span className="sr-only">{RSS_HELP}</span>
              <span
                className="ml-auto w-12 flex-none text-right text-[10px] text-muted-4 uppercase"
                title={CPU_HELP}
              >
                CPU
              </span>
              <span
                className="w-[68px] flex-none text-right text-[10px] text-muted-4 uppercase"
                title={RSS_HELP}
              >
                RSS
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {usage.data === undefined ? (
              <ListSkeleton rows={4} className="px-2" />
            ) : usage.data.repos.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-muted-3">
                No terminals are running.
              </div>
            ) : (
              usage.data.repos.map((r) => <RepoRows key={r.repo} r={r} cores={cores} />)
            )}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
