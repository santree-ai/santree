import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/** One rAF clock for every scripted animation in the demo (typewriter,
 * spinners, elapsed clocks, auto-advance). A single loop means a single
 * on/off switch: when `playing` drops (off-screen, hidden tab, reduced
 * motion) the clock freezes, and everything resumes mid-word instead of
 * jumping. Subscribers re-render only themselves at their own cadence. */

interface Subscriber {
  intervalMs: number;
  next: number;
  cb: () => void;
}

interface TickerCtx {
  subscribe: (sub: Subscriber) => () => void;
}

const Ctx = createContext<TickerCtx | null>(null);

export function TickerProvider({ playing, children }: { playing: boolean; children: ReactNode }) {
  const subs = useRef<Set<Subscriber>>(new Set());
  const elapsed = useRef(0);

  const ctx = useMemo<TickerCtx>(
    () => ({
      subscribe(sub) {
        sub.next = elapsed.current + sub.intervalMs;
        subs.current.add(sub);
        return () => subs.current.delete(sub);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Clamp so a background-throttled gap doesn't fast-forward the story.
      elapsed.current += Math.min(now - last, 250);
      last = now;
      for (const sub of subs.current) {
        if (elapsed.current >= sub.next) {
          sub.next += sub.intervalMs;
          // Fell far behind (e.g. throttled tab): don't burst-fire.
          if (sub.next < elapsed.current) sub.next = elapsed.current + sub.intervalMs;
          sub.cb();
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

/** Counts ticker quanta of `intervalMs` while enabled; 0 on the server and
 * on every first client render, so SSR markup is deterministic. */
export function useTick(intervalMs: number, enabled = true): number {
  const ctx = useContext(Ctx);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!ctx || !enabled) return;
    return ctx.subscribe({
      intervalMs,
      next: 0,
      cb: () => setCount((c) => c + 1),
    });
  }, [ctx, enabled, intervalMs]);

  return count;
}
