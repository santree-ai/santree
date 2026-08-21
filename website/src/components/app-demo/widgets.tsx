import type { CheckState, SessionState, TicketPriority } from "./data";
import { useTick } from "./ticker";

/** Leaf widgets for the demo window, authored at design-canvas density
 * (10-13px type — the whole canvas is scaled as one unit) and mirroring the
 * real app's primitives (Dot, Pill, Badge, PrChip, the checkbox column).
 * The "life signs" (spinner, glowing dots) keep the frame from reading as a
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

/** Session-state colors + words, mirroring the app's sessionStateMeta:
 * running green (glows), delegating blue, waiting-on-you red (glows). */
export const SESSION_STATE_META: Record<
  SessionState,
  { color: string; label: string; pulse: boolean }
> = {
  running: { color: "var(--color-status-green)", label: "running", pulse: true },
  waiting: { color: "var(--color-status-red)", label: "waiting", pulse: true },
  delegating: { color: "var(--color-status-blue)", label: "delegating", pulse: false },
  merged: { color: "var(--color-muted-2)", label: "exited", pulse: false },
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

/** A plain colored dot (the app's `Dot` primitive) for statuses that don't pulse. */
export function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: color }}
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

/** The WIP / RDY / draft chip family — mono uppercase in a tinted wash. */
export function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded px-1 py-px font-mono text-[8.5px] font-semibold uppercase tracking-wide"
      style={{
        color,
        background: "color-mix(in srgb, currentcolor 12%, transparent)",
        border: "1px solid color-mix(in srgb, currentcolor 35%, transparent)",
      }}
    >
      {children}
    </span>
  );
}

/** GitHub-style PR chip: the mark + #number, tinted by merge state (open is
 * Primer's neutral gray, merged its done-purple — like the real PrChip). */
export function PrChip({ num, state }: { num: number; state: "open" | "merged" }) {
  const color = state === "merged" ? "#a371f7" : "#848d97";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide"
      style={{
        color,
        background: "color-mix(in srgb, currentcolor 12%, transparent)",
        border: "1px solid color-mix(in srgb, currentcolor 35%, transparent)",
      }}
    >
      <GitHubMark size={9} />#{num}
    </span>
  );
}

export const PRIORITY_META: Record<TicketPriority, { color: string; label: string }> = {
  urgent: { color: "var(--color-status-red)", label: "Urgent" },
  high: { color: "var(--color-status-amber)", label: "High" },
  medium: { color: "var(--color-status-blue)", label: "Medium" },
  low: { color: "var(--color-muted-2)", label: "Low" },
};

export function PriorityPill({
  priority,
  muted = false,
}: {
  priority: TicketPriority;
  muted?: boolean;
}) {
  const meta = PRIORITY_META[priority];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.04em]"
      style={{
        color: muted ? "var(--color-muted-4)" : meta.color,
        background: "color-mix(in srgb, currentcolor 12%, transparent)",
        border: "1px solid color-mix(in srgb, currentcolor 30%, transparent)",
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

/** The always-present select box at the left of list rows (Trees / Issues /
 * Triage) — outlined when empty, accent-filled with a check when selected. */
export function SelectBox({
  selected = false,
  faint = false,
}: {
  selected?: boolean;
  faint?: boolean;
}) {
  return (
    <span
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-bold ${faint ? "opacity-45" : ""}`}
      style={
        selected
          ? { background: "var(--color-accent)", color: "var(--color-on-accent)" }
          : { border: "1px solid var(--color-line-2)" }
      }
      aria-hidden
    >
      {selected ? "✓" : ""}
    </span>
  );
}

/** Initials avatar, like the app's Avatar fallback. */
export function InitialsAvatar({ initials, size = 17 }: { initials: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-white/8 font-medium text-muted"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      aria-hidden
    >
      {initials}
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
    <span className="inline-flex h-[5px] w-24 overflow-hidden rounded-full bg-white/8">
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

/* ---- Tiny chrome glyphs (stroke icons at canvas density) ---- */

interface GlyphProps {
  size?: number;
  className?: string;
}

function StrokeSvg({
  size = 12,
  className = "",
  children,
}: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function ChevronDownGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M4 6.5l4 4 4-4" />
    </StrokeSvg>
  );
}

export function ChevronLeftGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M9.5 4l-4 4 4 4" />
    </StrokeSvg>
  );
}

export function ChevronRightGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M6.5 4l4 4-4 4" />
    </StrokeSvg>
  );
}

export function PlusGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </StrokeSvg>
  );
}

export function BranchGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 6.6c0 2.5-3 3-5.5 3.4" />
    </StrokeSvg>
  );
}

export function RefreshGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.7h-2.7" />
    </StrokeSvg>
  );
}

export function GearGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.2v1.9M8 11.9v1.9M2.2 8h1.9M11.9 8h1.9M3.9 3.9l1.3 1.3M10.8 10.8l1.3 1.3M12.1 3.9l-1.3 1.3M5.2 10.8l-1.3 1.3" />
    </StrokeSvg>
  );
}

export function HelpGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.2c.2-1 1-1.6 1.9-1.6 1 0 1.8.7 1.8 1.6 0 1.3-1.8 1.4-1.8 2.6" />
      <circle cx="8.1" cy="11.3" r="0.4" fill="currentColor" stroke="none" />
    </StrokeSvg>
  );
}

export function PanelGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.5" />
      <path d="M9.8 3v10" />
    </StrokeSvg>
  );
}

export function CollapseGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.5" />
      <path d="M6.2 3v10" />
    </StrokeSvg>
  );
}

export function CopyGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 3.5v-.3A1.2 1.2 0 0 0 9.3 2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h.3" />
    </StrokeSvg>
  );
}

export function PushGlyph(props: GlyphProps) {
  return (
    <StrokeSvg {...props}>
      <path d="M8 13V4M4.5 7.5L8 4l3.5 3.5" />
    </StrokeSvg>
  );
}

/** The GitHub mark, filled, for PR chips and the reviews header. */
export function GitHubMark({ size = 11, className = "" }: GlyphProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

/** The Linear mark, for the triage header's "Open Issue". */
export function LinearMark({ size = 11, className = "" }: GlyphProps) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M1.23 61.75a2 2 0 0 1 .53-1.9l58.09-58.1a2 2 0 0 1 1.9-.52 50.1 50.1 0 0 1 12.2 4.83L4.9 75.11a50.1 50.1 0 0 1-3.67-13.36zm8.5 22.24a2 2 0 0 1 .06-2.79L81.2 9.79a2 2 0 0 1 2.79-.06 50.55 50.55 0 0 1 6.28 7.28L17 91.27a50.55 50.55 0 0 1-7.28-6.28zm15.4 10.32a2 2 0 0 1-.6-3.24L93.07 22.5a2 2 0 0 1 3.24.6 50.09 50.09 0 0 1 2.62 8.51 2 2 0 0 1-.54 1.86L38.5 93.36a2 2 0 0 1-1.86.54 50.09 50.09 0 0 1-8.51-2.62l-3-1z"
      />
    </svg>
  );
}
