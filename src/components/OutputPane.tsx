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
import { useEffect, useRef } from "react";

import { StopIcon } from "../components/icons";
import { XtermRenderer } from "../features/terminal/XtermRenderer";
import { formatRelativeTime, useLiveNow } from "../lib/relativeTime";
import { useStreamRun } from "../state/useStreamRun";
import { Button, Spinner } from "./primitives";

/** Matches the PTY grid the backend runs commands under (`stream::COLS`). Pinning
 *  the view to the same width is what makes the output lay out as the tool intended:
 *  it wrapped its lines for 120 columns once, at write time, and no later resize can
 *  rewrap them. A narrower pane scrolls horizontally instead of re-wrapping into a
 *  mess. */
const COLS = 120;

export function OutputPane({
  runKey,
  label,
  onStop,
  stopping = false,
}: {
  /** Which run in `streamRuns` to show (and follow). */
  runKey: string;
  /** What's running, for the header — e.g. `pnpm tauri build`. */
  label: string;
  /** Omit to render no Stop button (a run that can't be cancelled). */
  onStop?: () => void;
  stopping?: boolean;
}) {
  const run = useStreamRun(runKey);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermRenderer | null>(null);
  /** How much of `run.chunks` this terminal has already been given, and which
   *  generation that cursor refers to. A generation change means the buffer was
   *  replaced or trimmed, so the cursor is meaningless and we replay from zero. */
  const written = useRef({ gen: -1, count: 0 });

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

    // Height follows the pane; width stays at the PTY's.
    const resize = () => {
      const { rows } = term.fit();
      term.resize(COLS, Math.max(rows, 1));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

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
      {/* The grid is a fixed 120 columns wide (see COLS) — let it scroll rather
          than squeeze. `min-h-0` so the flex child can actually shrink. */}
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
