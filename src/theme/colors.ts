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
  Done: palette.purple,
};

/**
 * Color + label for a pull request's state on its chip. Uses GitHub Primer's
 * standard state colors (dark-mode values) so the chip reads like GitHub:
 *   open → neutral gray · merged → "done" purple · closed → danger red.
 * Reserved for when CI/merge-queue status is wired: enqueued → attention yellow
 * (`#d29922`), CI failing → danger red (`#f85149`).
 */
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
  Awaiting: palette.amber,
  Idle: "#6b6b73",
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

/**
 * Mix any color with transparency via `color-mix`, e.g. for tinted backgrounds
 * and borders. `pct` is the opacity percentage of `color` (0–100); the rest is
 * transparent. Defaults to the live accent so `alpha(pct)` reproduces the
 * per-feature accent tint helper that several graph/sidebar views used locally.
 */
export function alpha(pct: number, color: string = accentVar): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
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
