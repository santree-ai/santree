/** Words for the local santree server's state (docs/server.md, "UX"): the one
 *  place the Settings card, the banner, the status-bar dot, a lost pane and the
 *  confirm dialogs get them, so they cannot disagree — and an unknown count can
 *  never be drawn as `0`. */
import type { ServerState, SessionCount } from "../bindings";
import { useHeldFor } from "./useHeldFor";

const plural = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

/** "3 sessions", or "an unknown number of sessions" when the server didn't say.
 *  `Unknown` may hold agents, so it never reads as "no sessions". */
export function sessionCountText(count: SessionCount): string {
  return count.kind === "Known" ? plural(count.count) : "an unknown number of sessions";
}

/** A running server's own count is a fact; reuse the same wording. */
export const knownCount = (count: number): SessionCount => ({ kind: "Known", count });

/** What a confirm says will end. Names the count, then bounds the loss: agents
 *  come back through Resume on their tabs. */
function endsText(count: SessionCount): string {
  if (count.kind === "Known" && count.count === 0) {
    return "No sessions are running, so nothing else will end.";
  }
  return `This ends ${sessionCountText(count)}, including any agent still working. Agents can be resumed from their tabs; anything unsaved in a shell is lost.`;
}

export const restartConfirm = (count: SessionCount) =>
  `Restart the santree server? ${endsText(count)}`;

export const stopConfirm = (count: SessionCount) =>
  `Stop the santree server? ${endsText(count)} Nothing starts it again until you press Start.`;

export const endDrainingConfirm = (revision: number, count: SessionCount) =>
  `End the older server r${revision} now? ${endsText(count)}`;

/** "<1m", "5m", "3h 12m", "2d 4h": an uptime to read at a glance, to the minute. */
export function formatUptime(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export type ServerTone = "ok" | "pending" | "warn" | "error";

/** The status-bar and banner dot for each tone. */
export const TONE_DOT: Record<ServerTone, string> = {
  ok: "bg-status-green",
  pending: "bg-status-amber",
  warn: "bg-status-amber",
  error: "bg-status-red",
};

export interface ServerStateView {
  /** The card's state line. */
  title: string;
  /** The status bar's few words. */
  short: string;
  /** What the banner and the dot's tooltip lead with. */
  sentence: string;
  tone: ServerTone;
  /** Why a lost pane cannot be resumed in this state: resuming opens a new
   *  session, which a server that is down, starting or stopping would refuse or
   *  lose at birth. */
  blocksResume?: string;
  /** When the window chrome (banner, dot) speaks: at once, only once the state
   *  has lasted {@link TRANSITION_GRACE_MS}, or never. */
  attention: "now" | "held" | "never";
}

/** How long a start or a stop goes unremarked: the ordinary one is over well
 *  inside it. */
export const TRANSITION_GRACE_MS = 2_000;

const NOT_UP = "Start the santree server first: a resumed session needs it.";

export function serverStateView(state: ServerState): ServerStateView {
  switch (state.kind) {
    case "Off":
      return {
        title: "Off",
        short: "no server",
        sentence: "Terminals run inside santree.",
        tone: "ok",
        attention: "never",
      };
    case "Running":
      return {
        title: "Running",
        short: "server running",
        sentence: "The santree server is running.",
        tone: "ok",
        attention: "never",
      };
    case "Starting":
      return {
        title: "Starting…",
        short: "server starting…",
        sentence: "Starting the santree server…",
        tone: "pending",
        blocksResume: "Waiting for the santree server to start.",
        attention: "held",
      };
    case "Stopping":
      return {
        title: "Stopping…",
        short: "server stopping…",
        sentence: "Stopping the santree server…",
        tone: "pending",
        blocksResume: "The santree server is stopping.",
        attention: "held",
      };
    case "Down":
      return {
        title: "Not running",
        short: "server stopped",
        sentence: "The santree server isn't running.",
        tone: "warn",
        blocksResume: NOT_UP,
        attention: "now",
      };
    case "Failing":
      return {
        title: "Keeps stopping",
        short: "server failing",
        sentence: "The santree server keeps stopping.",
        tone: "error",
        blocksResume: NOT_UP,
        attention: "now",
      };
  }
}

/** Whether the window chrome should speak about the server right now: one rule
 *  for the banner and the dot, so neither says "Starting…" without the other. */
export function useServerAttention(state: ServerState | undefined): boolean {
  const attention = state ? serverStateView(state).attention : "never";
  const held = useHeldFor(attention === "held", TRANSITION_GRACE_MS);
  return attention === "now" || held;
}
