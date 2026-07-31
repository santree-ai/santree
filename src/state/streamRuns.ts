/**
 * The transcripts of background command runs (the Dev tab's build, a worktree's
 * setup script), keyed by an opaque run key.
 *
 * Module-scoped rather than a context, deliberately: the whole point is that the
 * output outlives the pane showing it. A build keeps streaming while you're on
 * another tab, and its result is still there when you come back — until you start
 * the next one. React state would need a provider at the app shell whose only job is
 * to survive its consumers; an external store says that directly, and `useStreamRun`
 * subscribes to exactly one key so a chatty build doesn't re-render the app.
 *
 * Output is kept as the raw chunks the backend sent (escape codes intact) in arrival
 * order, never joined: the view replays them into a terminal emulator, which is what
 * makes the colours and progress redraws come out right, and appending to one big
 * string on every chunk is quadratic over a build's worth of output.
 */
import type { StreamEvent } from "../bindings";

export interface StreamRun {
  /** Raw PTY chunks in arrival order. Not line-aligned — only meaningful replayed
   *  in sequence into a VT emulator. */
  chunks: string[];
  running: boolean;
  /** How the last finished run ended; null while running, or before any run. */
  ok: boolean | null;
  /** Identifies the run these chunks belong to. Incremented per start, and used to
   *  drop events from a *previous* run — a killed command's reader thread can emit
   *  after the next run has already begun. */
  runId: number;
  /** Bumped whenever `chunks` stops being an append-only continuation of what a
   *  view already wrote — a new run, or an old buffer trimmed. Views compare it
   *  against the generation they rendered and start over when it moves, instead of
   *  appending onto a transcript that no longer matches. */
  gen: number;
  /** When the current (or last) run started, ms since epoch. */
  startedMs: number;
}

/** Cap on a single run's retained output. A verbose release build prints a few
 *  hundred KB; a runaway loop can print unboundedly, and this store is never
 *  garbage-collected, so the buffer is trimmed from the front rather than trusted. */
export const MAX_CHARS = 2_000_000;

const EMPTY: StreamRun = {
  chunks: [],
  running: false,
  ok: null,
  runId: 0,
  gen: 0,
  startedMs: 0,
};

const runs = new Map<string, StreamRun>();
const listeners = new Map<string, Set<() => void>>();

function publish(key: string, run: StreamRun) {
  runs.set(key, run);
  for (const l of listeners.get(key) ?? []) l();
}

/** Drop the oldest chunks until the buffer is back under the cap. Returns the same
 *  array when nothing had to go, so callers can tell a trim from an append. */
export function trim(chunks: string[]): string[] {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total <= MAX_CHARS) return chunks;
  let drop = 0;
  while (drop < chunks.length && total > MAX_CHARS) {
    total -= chunks[drop].length;
    drop += 1;
  }
  return chunks.slice(drop);
}

export function getRun(key: string): StreamRun {
  return runs.get(key) ?? EMPTY;
}

export function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(key);
  };
}

/** The run key for a worktree's setup script. Mirrors the backend's own key shape
 *  (see `worktree::setup_key`) closely enough to read in a debugger, but it only has
 *  to be unique *here* — the backend keys by repo root, which the frontend doesn't
 *  have, and one worktree id can't be running setup in two repos at once. */
export const setupRunKey = (worktreeId: string) => `setup:${worktreeId}`;

/** A Channel-shaped sink. Typed structurally so this store never imports Tauri. */
export interface EventSink {
  onmessage: (e: StreamEvent) => void;
}

/**
 * Start a run under `key`, replacing whatever the previous one left behind.
 *
 * Imperative by design — never call it from an effect. Spawning a process isn't
 * idempotent, and an effect would re-fire the build every time the pane remounted
 * (which is exactly how the old terminal-seeded build behaved).
 *
 * `makeChannel` is injected rather than constructed here so the store stays
 * testable without Tauri.
 */
export function startRun(
  key: string,
  makeChannel: () => EventSink,
  invoke: (channel: EventSink) => Promise<{ status: string; error?: string }>,
  nowMs: number,
  /** Fires once when the run settles, however it settled — the command exiting, or
   *  failing to start at all. For callers with work queued behind the run (setup
   *  hands off to the agent); the pane itself just reads `running`. */
  onSettled?: () => void,
): void {
  const prev = getRun(key);
  if (prev.running) return;
  const runId = prev.runId + 1;
  publish(key, {
    chunks: [],
    running: true,
    ok: null,
    runId,
    gen: prev.gen + 1,
    startedMs: nowMs,
  });

  const channel = makeChannel();
  channel.onmessage = (e) => {
    const run = getRun(key);
    if (run.runId !== runId) return; // a straggler from the previous run
    if (e.type === "done") {
      publish(key, { ...run, running: false, ok: e.ok });
      onSettled?.();
      return;
    }
    const appended = [...run.chunks, e.text];
    const chunks = trim(appended);
    publish(key, {
      ...run,
      chunks,
      // A trim invalidates the view's write cursor; a plain append doesn't.
      gen: chunks === appended ? run.gen : run.gen + 1,
    });
  };

  void invoke(channel).then((r) => {
    if (r.status !== "error") return;
    const run = getRun(key);
    if (run.runId !== runId) return;
    publish(key, {
      ...run,
      chunks: [...run.chunks, `\r\n\x1b[31m${r.error ?? "failed to start"}\x1b[0m\r\n`],
      running: false,
      ok: false,
    });
    onSettled?.();
  });
}

/** Settle a run locally without waiting for its Done event — the Stop button, whose
 *  kill reaches the process asynchronously. A late Done for the same run is still
 *  accepted (same runId); it just reports the same failure. */
export function markStopped(key: string): void {
  const run = getRun(key);
  if (!run.running) return;
  publish(key, { ...run, running: false, ok: false });
}

/** Drop every run (tests only — this store is process-wide). */
export function resetAll(): void {
  runs.clear();
  listeners.clear();
}
