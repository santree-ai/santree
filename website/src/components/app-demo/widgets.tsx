import type { CheckState, SessionState, TicketPriority } from "./data";
import { useTick } from "./ticker";

/** Leaf widgets for the demo window, authored at design-canvas density
 * (10-13px type — the whole canvas is scaled as one unit). The two
 * "life signs" (spinner, glowing dots) keep the frame from reading as a
 * screenshot; both freeze to a clean state when the ticker is paused. */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function AsciiSpinner({ className = "" }: { className?: string }) {
  const tick = useTick(125);
  return (
    <span className={`font-mono ${className}`} aria-hidden>
      {SPINNER_FRAMES[tick % SPINNER_FRAMES.length]}
    </span>
  );
}

/** m:ss clock seeded from data so t=0 already shows a believable mid-run
 * time; ticks up only while the demo plays. */
export function ElapsedClock({ baseSec }: { baseSec: number }) {
  const sec = baseSec + useTick(1000);
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, "0");
  return (
    <span className="font-mono tabular-nums text-[10px] text-muted-2">
      {m}:{s}
    </span>
  );
}

export const SESSION_STATE_META: Record<
  SessionState,
  { color: string; label: string; pulse: boolean }
> = {
  running: { color: "var(--color-status-green)", label: "running", pulse: true },
  waiting: { color: "var(--color-status-red)", label: "needs you", pulse: true },
  delegating: { color: "var(--color-status-blue)", label: "delegating", pulse: false },
  merged: { color: "var(--color-status-purple)", label: "merged", pulse: false },
};

export function StatusDot({ state }: { state: SessionState }) {
  const meta = SESSION_STATE_META[state];
  return (
    <span
      className={meta.pulse ? "demo-dot demo-dot-pulse" : "demo-dot"}
      style={{ "--dot-color": meta.color } as React.CSSProperties}
      aria-hidden
    />
  );
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="font-mono tabular-nums text-[10px]">
      <span className="text-status-green">+{add}</span>{" "}
      <span className="text-status-red">−{del}</span>
    </span>
  );
}

export function PrChip({ num, state }: { num: number; state: "open" | "merged" }) {
  const color = state === "merged" ? "var(--color-status-purple)" : "var(--color-status-green)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px]"
      style={{ color, borderColor: "color-mix(in srgb, currentcolor 35%, transparent)" }}
    >
      #{num} {state}
    </span>
  );
}

export const PRIORITY_META: Record<TicketPriority, { color: string; label: string }> = {
  urgent: { color: "var(--color-status-red)", label: "Urgent" },
  high: { color: "var(--color-status-amber)", label: "High" },
  medium: { color: "var(--color-status-blue)", label: "Medium" },
  low: { color: "var(--color-muted-2)", label: "Low" },
};

export function PriorityPill({ priority }: { priority: TicketPriority }) {
  const meta = PRIORITY_META[priority];
  return (
    <span
      className="inline-flex items-center rounded px-1 py-px font-mono text-[9px] uppercase tracking-wide"
      style={{
        color: meta.color,
        background: "color-mix(in srgb, currentcolor 12%, transparent)",
      }}
    >
      {meta.label}
    </span>
  );
}

export const CHECK_META: Record<CheckState, { glyph: string; color: string }> = {
  pass: { glyph: "✓", color: "var(--color-status-green)" },
  fail: { glyph: "✕", color: "var(--color-status-red)" },
  pending: { glyph: "◴", color: "var(--color-status-amber)" },
};

export function CheckGlyph({ state }: { state: CheckState }) {
  const meta = CHECK_META[state];
  return (
    <span className="font-mono text-[10px]" style={{ color: meta.color }} aria-hidden>
      {meta.glyph}
    </span>
  );
}

/** Context-fill bar from the session status line: green under 60%. */
export function ContextBar({ pct }: { pct: number }) {
  const color =
    pct < 60
      ? "var(--color-status-green)"
      : pct < 80
        ? "var(--color-status-amber)"
        : "var(--color-status-red)";
  return (
    <span className="inline-flex h-[5px] w-16 overflow-hidden rounded-full bg-white/8">
      <span className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

/** The Claude spark — the app's AI-action icon convention, miniaturized. */
export function ClaudeSpark({ size = 9, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M8 0l1.9 5.4L15.5 6l-4.4 3.6L12.7 15 8 11.9 3.3 15l1.6-5.4L.5 6l5.6-.6z"
      />
    </svg>
  );
}
