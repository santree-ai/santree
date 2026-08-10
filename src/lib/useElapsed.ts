/**
 * Elapsed milliseconds since `active` last became true — the clock behind every
 * "still running" readout.
 *
 * A spinner alone can't distinguish *working* from *wedged*, which is exactly the
 * question a user asks two minutes into an AI call. A ticking number answers it
 * without the backend having to report progress it doesn't have.
 *
 * Ticks once a second: fine for a m:ss readout, and cheap enough to leave mounted.
 * Returns 0 whenever `active` is false, so a caller can render unconditionally.
 */
import { useEffect, useRef, useState } from "react";

const TICK_MS = 1000;

export function useElapsed(active: boolean): number {
  const startedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    // Anchor on the first active render, not on the interval's first fire, or the
    // readout is a second behind for the whole run.
    startedAt.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => {
      if (startedAt.current !== null) setElapsed(Date.now() - startedAt.current);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return elapsed;
}

/** `m:ss` for a duration in milliseconds — 0:07, 1:04, 12:30. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
