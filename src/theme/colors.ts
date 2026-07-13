/**
 * Presentation layer for the domain enums.
 *
 * The backend ships plain discriminants (status, priority, tone, …); this module
 * is the single place that turns them into concrete colors and human labels.
 * Small, data-driven bits (graph dots, edge strokes, progress bars) read these
 * hex values via inline styles; structural styling uses Tailwind tokens.
 */
import type { CSSProperties } from "react";

import type {
  Activity,
  AgentKind,
  CheckRollup,
  CheckStatus,
  MergeQueueState,
  Priority,
  PrState,
  ReviewDecision,
  TaskStatus,
} from "../bindings";

/** Raw palette — kept in sync with the `@theme` tokens in styles.css. */
export const palette = {
  green: "#3fb950",
  blue: "#4493f8",
  indigo: "#5b8def",
  amber: "#d29922",
  red: "#f85149",
  purple: "#a78bfa",
  slate: "#6e7681",
  cyan: "#6fd3e0",
  cross: "#c98a4a",
  text: "#c8c8d0",
  muted: "#5b5b63",
} as const;

/** The default accent; the live value is the `--accent` CSS variable. */
export const DEFAULT_ACCENT = "#2dd4a7";

/** Fixed, deterministic palette for {@link Avatar} initials — a name hashes to
 *  one of these. Literal hex (not theme colors): the same name must map to the
 *  same swatch regardless of light/dark. */
export const AVATAR_PALETTE = [
  "#5b8def",
  "#a78bfa",
  "#2dd4a7",
  "#d29922",
  "#f0709a",
  "#6fd3e0",
] as const;

/** Semantic "success / ready / done" green — the single source for the green
 *  used by RDY badges, ready dots, and done markers (was hardcoded as the raw
 *  hex across several issue components). Mirrors the `--color-status-green` token. */
export const successColor = palette.green;

/** Linear's brand color (the `--linear-brand` token), for the Linear logo/badge
 *  in integration surfaces. */
export const LINEAR_BRAND = "var(--linear-brand)";

export const statusColor: Record<TaskStatus, string> = {
  InReview: palette.green,
  InProgress: palette.amber,
  Todo: palette.blue,
  Backlog: palette.slate,
  Blocked: palette.red,
  Done: palette.purple,
};

/** Family key + label + color for a raw Claude model id (`claude-opus-4-8` →
 *  opus / "Opus" / purple), for the Usage panel's per-model bars and session
 *  badges. `key` groups every version of a family together; matched by substring
 *  so it survives version bumps. An unknown id shows verbatim in slate. */
export function modelMeta(model: string): { key: string; label: string; color: string } {
  const m = model.toLowerCase();
  if (m.includes("opus")) return { key: "opus", label: "Opus", color: palette.purple };
  if (m.includes("sonnet")) return { key: "sonnet", label: "Sonnet", color: palette.blue };
  if (m.includes("haiku")) return { key: "haiku", label: "Haiku", color: palette.green };
  if (m.includes("fable")) return { key: "fable", label: "Fable", color: palette.amber };
  return { key: model, label: model, color: palette.slate };
}

/** A specific version label for a raw model id, for hover detail — `Opus 4.8`,
 *  `Sonnet 4.6`, `Fable 5`, `Haiku 4.5`. Falls back to the family label (or the
 *  raw id for an unknown family) when no version is encoded. */
export function modelVersion(model: string): string {
  const { key, label } = modelMeta(model);
  if (key === model) return model; // unknown family → raw id
  const m = model.toLowerCase().match(/(?:opus|sonnet|haiku|fable)-(\d+(?:-\d+)?)/);
  return m ? `${label} ${m[1].replace("-", ".")}` : label;
}

/** Color + label for a pull request's state on its chip. Uses GitHub Primer's
 *  standard state colors (dark-mode values) so the chip reads like GitHub:
 *  open → neutral gray · merged → "done" purple · closed → danger red. */
export const prStateMeta: Record<PrState, { color: string; label: string }> = {
  Open: { color: "#848d97", label: "open" },
  Merged: { color: "#a371f7", label: "merged" },
  Closed: { color: "#f85149", label: "closed" },
};

/** Color + label for a PR's aggregate review decision (Reviews dashboard). */
export const reviewDecisionMeta: Record<ReviewDecision, { color: string; label: string }> = {
  Approved: { color: palette.green, label: "approved" },
  ChangesRequested: { color: palette.red, label: "changes requested" },
  ReviewRequired: { color: palette.amber, label: "review required" },
  None: { color: palette.slate, label: "no review" },
};

/** Color + glyph + label for a PR's rolled-up CI checks (Reviews dashboard). */
export const checkRollupMeta: Record<CheckRollup, { color: string; glyph: string; label: string }> =
  {
    Success: { color: palette.green, glyph: "✓", label: "checks passing" },
    Failure: { color: palette.red, glyph: "✕", label: "checks failing" },
    Pending: { color: palette.amber, glyph: "◴", label: "checks running" },
    None: { color: palette.slate, glyph: "–", label: "no checks" },
  };

/** Badge for a PR sitting in the repo's merge queue (GitHub's "Queued" state).
 *  Attention-yellow, matching the reserved merge-queue color noted above. */
export const mergeQueueMeta = {
  color: palette.amber,
  glyph: "⧗",
  label: "queued to merge",
} as const;

/** Color + label for a merge-queue entry's state (Reviews merge-queue panel). */
export const mergeQueueStateMeta: Record<MergeQueueState, { color: string; label: string }> = {
  Queued: { color: palette.slate, label: "queued" },
  AwaitingChecks: { color: palette.amber, label: "checks running" },
  Mergeable: { color: palette.green, label: "ready to merge" },
  Unmergeable: { color: palette.red, label: "cannot merge" },
  Locked: { color: palette.blue, label: "locked" },
  Unknown: { color: palette.slate, label: "" },
};

/** Color + glyph + label for a single CI check's status (Reviews Checks tab). */
export const checkStatusMeta: Record<CheckStatus, { color: string; glyph: string; label: string }> =
  {
    Success: { color: palette.green, glyph: "✓", label: "passed" },
    Failure: { color: palette.red, glyph: "✕", label: "failed" },
    Pending: { color: palette.amber, glyph: "◴", label: "running" },
    Skipped: { color: palette.slate, glyph: "↷", label: "skipped" },
    Neutral: { color: palette.slate, glyph: "–", label: "neutral" },
  };

export const statusLabel: Record<TaskStatus, string> = {
  InReview: "In Review",
  InProgress: "In Progress",
  Todo: "Todo",
  Backlog: "Backlog",
  Blocked: "Blocked",
  Done: "Done",
};

export const priorityColor: Record<Priority, string> = {
  Urgent: palette.red,
  High: palette.amber,
  Medium: palette.blue,
  Low: palette.slate,
  None: palette.muted,
};

export const activityColor: Record<Activity, string> = {
  Running: "var(--accent)",
  Idle: "#6b6b73",
};

/** Color + label for a live Claude session state (from the session-signal hooks
 *  the app injects into its `claude` launches). `waiting` = the agent needs your
 *  input (red, glows for attention); `active` = a turn is running (green);
 *  `idle` = the turn finished (amber). `exited` is intentionally absent — a
 *  finished session shows no indicator. Keyed by the raw `state` string. */
// `short` is the compact inline word (e.g. on a card); `label` is the fuller
// tooltip text. `active` reads as "running" — a turn is in progress, i.e. the
// agent is working (thinking / running tools), which "active" didn't convey.
export const sessionStateMeta: Record<
  string,
  { color: string; short: string; label: string; glow?: boolean }
> = {
  active: { color: palette.green, short: "running", label: "Running", glow: true },
  // The main loop has handed off and is blocked on a Task subagent — working, but
  // not the agent itself, and NOT "needs you". Blue reads as busy/info, distinct
  // from green (running) and amber (idle).
  delegating: { color: palette.blue, short: "delegating", label: "Running a subagent" },
  // A tool is blocked on your approval — the sharpest "act now". Same urgent red
  // as `waiting`, distinguished by label (color = urgency, label = reason).
  permission: { color: palette.red, short: "permission", label: "Needs permission", glow: true },
  waiting: { color: palette.red, short: "waiting", label: "Waiting for input", glow: true },
  idle: { color: palette.amber, short: "idle", label: "Idle" },
  // The session ended (or isn't running). Muted, no glow — it recedes.
  exited: { color: palette.muted, short: "exited", label: "Exited" },
};

/** Fallback color for a project box when the backend sends no `project_color`
 *  (real projects ship one on the `Task` domain type). */
export const PROJECT_FALLBACK = palette.slate;

const AGENT_LABELS: Record<AgentKind, string> = {
  Claude: "Claude Code",
  Codex: "Codex",
  Cursor: "Cursor",
  Opencode: "OpenCode",
};

/** Full display name for an agent (e.g. "Claude Code"). */
export function agentLabel(kind: AgentKind): string {
  return AGENT_LABELS[kind];
}

/** Short, lower-case agent name used in terminals/logs (e.g. "claude"). */
export function agentSlug(kind: AgentKind): string {
  return kind === "Codex" ? "codex" : kind === "Opencode" ? "opencode" : "claude";
}

/**
 * The live accent as a CSS value (reads the runtime `--accent` token). Use this
 * instead of hardcoding the default accent hex so swatch changes flow through.
 */
export const accentVar = "var(--accent)";

/** The solid accent fill (`--accent-fill`) for primary buttons / launch
 *  checkboxes: the accent itself on dark, darkened on light so the white
 *  `--on-accent` content reads. Pair the two — never raw accent + on-accent. */
export const accentFillVar = "var(--accent-fill)";

/**
 * Mix any color with transparency via `color-mix`, e.g. for tinted backgrounds
 * and borders. `pct` is the opacity percentage of `color` (0–100); the rest is
 * transparent. Defaults to the live accent so `alpha(pct)` reproduces the
 * per-feature accent tint helper that several graph/sidebar views used locally.
 */
export function alpha(pct: number, color: string = accentVar): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/** Parse a 3- or 6-digit hex (with or without `#`) to HSL. Returns null on
 *  anything unparseable so callers can fall back to a neutral. */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  let h = hex.replace(/^#/, "").trim();
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue: number;
  if (max === r) hue = ((((g - b) / d) % 6) + 6) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return { h: hue * 60, s, l };
}

/**
 * A legible text/accent color derived from a raw GitHub/Linear **label** hex.
 * Those hexes are picked for a solid-fill chip, so using one directly as text
 * (the way we tint a chip's background) is unreadable — pale labels vanish in
 * light mode, dark ones in dark mode. Clamp the color's lightness into a
 * theme-appropriate band while preserving its hue, like GitHub's label text.
 * Falls back to a muted neutral for an unparseable hex.
 */
export function readableLabelColor(hex: string, theme: "light" | "dark"): string {
  const hsl = hexToHsl(hex);
  if (!hsl) return "var(--color-muted-2)";
  const l = theme === "dark" ? Math.max(hsl.l, 0.62) : Math.min(hsl.l, 0.36);
  return `hsl(${Math.round(hsl.h)} ${Math.round(hsl.s * 100)}% ${Math.round(l * 100)}%)`;
}

/**
 * The shared "active / selected" accent treatment: a faint accent fill, a
 * stronger accent border, and accent-colored text. Centralized so the fill/
 * border percentages can't drift across the many toggle/segment/selected
 * surfaces that hand-rolled the same `color-mix` trio with slightly different
 * numbers. Spread it into an element's `style`.
 */
export function accentActiveStyle(): CSSProperties {
  return {
    background: alpha(13),
    border: `1px solid ${alpha(40)}`,
    color: accentVar,
  };
}

/**
 * Style for a small icon button that toggles into the accent-active treatment
 * when `active` (open/selected) — shared by the sidebar footer's Help and
 * Settings buttons so a menu-open button and a route-active button look the
 * same way "on".
 */
export function iconButtonStyle(active: boolean): CSSProperties {
  return active
    ? accentActiveStyle()
    : {
        background: "transparent",
        borderColor: "var(--color-line-3)",
        color: "var(--color-muted-2)",
      };
}
