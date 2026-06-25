/**
 * Presentation layer for the domain enums.
 *
 * The backend ships plain discriminants (status, priority, tone, …); this module
 * is the single place that turns them into concrete colors and human labels.
 * Small, data-driven bits (graph dots, edge strokes, progress bars) read these
 * hex values via inline styles; structural styling uses Tailwind tokens.
 */
import type { Activity, AgentKind, CheckState, Priority, TaskStatus, Tone } from "../bindings";

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

/** Accent options offered in Appearance settings. */
export const ACCENT_SWATCHES = ["#2dd4a7", "#5b8def", "#a78bfa", "#e3a008", "#f0709a"] as const;

export const statusColor: Record<TaskStatus, string> = {
  InReview: palette.green,
  InProgress: palette.amber,
  Todo: palette.blue,
  Backlog: palette.slate,
};

export const statusLabel: Record<TaskStatus, string> = {
  InReview: "In Review",
  InProgress: "In Progress",
  Todo: "Todo",
  Backlog: "Backlog",
};

export const priorityColor: Record<Priority, string> = {
  Urgent: palette.red,
  High: palette.amber,
  Medium: palette.blue,
  Low: palette.slate,
};

export const activityColor: Record<Activity, string> = {
  Running: "var(--accent)",
  Awaiting: palette.amber,
  Idle: "#6b6b73",
};

export const projectColor: Record<string, string> = {
  "Booking agent onboarding": palette.indigo,
  "Agent Knowledge: Config (VOX+MSG)": palette.purple,
  "No Project": palette.slate,
};

/** Color for a graph project box, defaulting to slate for unknown projects. */
export function colorForProject(project: string): string {
  return projectColor[project] ?? palette.slate;
}

/** Semantic terminal/diff tone → concrete color. */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case "Muted":
      return palette.muted;
    case "Default":
      return palette.text;
    case "Accent":
      return "var(--accent)";
    case "Green":
      return palette.green;
    case "Cyan":
      return palette.cyan;
    case "Amber":
      return palette.amber;
    case "Red":
      return palette.red;
  }
}

const AGENT_LABELS: Record<AgentKind, string> = {
  Claude: "Claude Code",
  Codex: "Codex",
  Opencode: "opencode",
};

/** Full display name for an agent (e.g. "Claude Code"). */
export function agentLabel(kind: AgentKind): string {
  return AGENT_LABELS[kind];
}

/** Short, lower-case agent name used in terminals/logs (e.g. "claude"). */
export function agentSlug(kind: AgentKind): string {
  return kind === "Codex" ? "codex" : kind === "Opencode" ? "opencode" : "claude";
}

export function checkPassing(state: CheckState): boolean {
  return state === "Passing";
}
