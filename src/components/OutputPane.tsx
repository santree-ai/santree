/**
 * A read-only view of a background command's output — the Dev tab's build and a
 * worktree's setup script both render through this.
 *
 * It renders with the same VT engine as the real terminal, so colours, progress
 * redraws and box-drawing come out exactly as the tool printed them. What it is
 * *not* is a terminal session: nothing is typed into it, the process is owned by
 * the backend rather than by this component's lifetime, and the transcript lives in
 * `streamRuns` — so leaving the tab mid-build and coming back shows the same run
 * still going, and a finished run stays on screen until the next one starts.
 */
import { useCallback, useEffect, useRef } from "react";

import { StopIcon } from "../components/icons";
import { XtermRenderer } from "../features/terminal/XtermRenderer";
import { formatRelativeTime, useLiveNow } from "../lib/relativeTime";
import { getRun } from "../state/streamRuns";
import { useStreamRun } from "../state/useStreamRun";
import { Button, Spinner } from "./primitives";

export function OutputPane({
  runKey,
  label,
  onStop,
  onResize,
  stopping = false,
}: {
  /** Which run in `streamRuns` to show (and follow). */
  runKey: string;
  /** What's running, for the header — e.g. `pnpm tauri build`. */
  label: string;
  /** Omit to render no Stop button (a run that can't be cancelled). */
  onStop?: () => void;
  /**
   * Report the pane's grid so the backend can re-grid the run's PTY to match.
   *
   * The view reflows the output it already has on its own — nothing hard-wrapped
   * those lines, so widening merges them back — but a tool still writing sizes its
   * progress bars to what the kernel tells it. Without this the live half of the log
   * keeps arriving laid out for the starting width. Owned by the call site, like
   * `onStop`, because the backend addresses runs by repo/worktree rather than by the
   * `streamRuns` key this component holds.
   */
  onResize?: (cols: number, rows: number) => void;
  stopping?: boolean;
}) {
  const run = useStreamRun(runKey);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermRenderer | null>(null);
  /** How much of `run.chunks` this terminal has already been given, and which
   *  generation that cursor refers to. A generation change means the buffer was
   *  replaced or trimmed, so the cursor is meaningless and we replay from zero. */
  const written = useRef({ gen: -1, count: 0 });
  // Read the latest reporter without re-running the mount-once effect, which would
  // tear down and rebuild the terminal.
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  // Last grid reported to the backend. A ResizeObserver fires on every pixel nudge
  // and most of those land on the same character grid, so — as in TerminalView —
  // only a real grid change is worth an IPC round-trip and a SIGWINCH.
  const sentRef = useRef({ cols: 0, rows: 0 });

  const commitResize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    if (cols === sentRef.current.cols && rows === sentRef.current.rows) return;
    sentRef.current = { cols, rows };
    onResizeRef.current?.(cols, rows);
  }, []);

  /**
   * Re-emulate the whole transcript at the terminal's current grid.
   *
   * xterm's live reflow is *lossy in one direction*: its buffer holds at most
   * `scrollback` rows, and narrowing turns each line into more rows, so the oldest
   * content is evicted — permanently, since the buffer was the only copy inside the
   * terminal. Widening back can't recover it. The bytes do survive, in `streamRuns`,
   * whose cap is in characters and so doesn't move with the width; replaying them is
   * what makes a resize lossless. Measured at ~20ms for a full 2MB transcript.
   */
  const replay = useCallback(
    (term: XtermRenderer) => {
      const run = getRun(runKey);
      term.reset();
      for (const chunk of run.chunks) term.write(chunk);
      written.current = { gen: run.gen, count: run.chunks.length };
    },
    [runKey],
  );

  // One renderer per mount. Not memoized into the module: xterm holds DOM and
  // (rationed) WebGL resources, so an unmounted pane must give them back — the
  // transcript it was showing lives in the store, not in here.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XtermRenderer({ readOnly: true });
    term.mount(host);
    termRef.current = term;
    written.current = { gen: -1, count: 0 };

    // Both dimensions follow the pane. `fit()` re-grids the terminal, which reflows
    // what's on screen for immediate feedback; `commitResize` re-grids the PTY so the
    // rest of the run arrives at the same width. A hidden pane measures zero, and
    // fit() then leaves the grid alone — the activation refit picks it up on return.
    // Seeded from the first fit rather than 0, so mounting doesn't count as a width
    // change: the feed effect below already paints the transcript, and replaying on
    // top of it would re-emulate the whole thing for nothing.
    const initial = term.fit();
    let lastCols = initial.cols;
    commitResize(initial.cols, initial.rows);

    let settle: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      const { cols, rows } = term.fit();
      commitResize(cols, rows);
      if (cols === lastCols) return;
      lastCols = cols;
      // Once the drag settles, rebuild from the source bytes — xterm's own reflow got
      // us something to look at instantly, but only a replay is lossless (see
      // `replay`). Debounced because a drag fires this every few pixels and each
      // replay re-emulates the entire transcript.
      clearTimeout(settle);
      settle = setTimeout(() => replay(term), 120);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      clearTimeout(settle);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [commitResize, replay]);

  // A run started under an already-mounted pane comes up on the backend's default
  // grid, and nothing resizes the pane afterwards to correct it. Re-send on the
  // transition into `running` — that PTY has never been told this pane's size.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (run.running && !wasRunning.current) {
      const { cols, rows } = sentRef.current;
      if (cols > 0 && rows > 0) onResizeRef.current?.(cols, rows);
    }
    wasRunning.current = run.running;
  }, [run.running]);

  // Feed the terminal whatever it hasn't seen. Runs after every store change (and
  // once on mount, which is what replays a finished run when you come back to it).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (written.current.gen !== run.gen) {
      term.reset();
      written.current = { gen: run.gen, count: 0 };
    }
    for (let i = written.current.count; i < run.chunks.length; i++) term.write(run.chunks[i]);
    written.current.count = run.chunks.length;
  }, [run.chunks, run.gen]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-1.5">
        <StatusLine run={run} label={label} />
        {run.running && onStop && (
          <Button
            variant="ghost"
            size="sm"
            className="flex-none whitespace-nowrap"
            disabled={stopping}
            onClick={onStop}
          >
            <StopIcon size={10} />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </div>
      {/* The grid is fitted to this box, so nothing should overflow horizontally —
          `overflow-auto` stays for the odd line a tool draws past the width it was
          told. `min-h-0` so the flex child can actually shrink. */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto px-2 py-1" />
    </div>
  );
}

function StatusLine({ run, label }: { run: ReturnType<typeof useStreamRun>; label: string }) {
  const now = useLiveNow();
  if (run.running) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-[11.5px] text-muted-2">
        <Spinner size={11} />
        <span className="truncate">
          Running <span className="font-mono">{label}</span>…
        </span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-[11.5px]">
      <span className={run.ok ? "text-status-green" : "text-status-red"}>{run.ok ? "✓" : "✕"}</span>
      <span className="truncate text-muted-2">
        <span className="font-mono">{label}</span> {run.ok ? "finished" : "failed"}
      </span>
      {run.startedMs > 0 && (
        <span className="flex-none text-muted-4">{formatRelativeTime(run.startedMs, now)}</span>
      )}
    </span>
  );
}
