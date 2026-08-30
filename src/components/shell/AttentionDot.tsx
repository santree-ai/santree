/**
 * The one status glyph the project tree speaks in — on an agent row, on the
 * worktree that aggregates it, and on the repo header above that.
 *
 * Motion carries the meaning: a working agent breathes and one blocked on you
 * pings, so anything moving on screen is either happening or asking. Everything
 * else is a still dot, which is what lets a tree of thirty rows stay readable.
 * Hue is reserved for exactly this — the rest of the tree's hierarchy is built
 * from muted tokens, so a color anywhere in it means state.
 */
import type { AttentionLevel } from "../../lib/attention";
import { palette } from "../../theme/colors";

/** Color, motion and hover label per level. `done` is the completion purple the
 *  merged-PR chip and the Done task status already use; `idle` is the neutral
 *  dot token, deliberately dimmer than any muted text so a resting tree reads as
 *  structure rather than status. */
export const attentionMeta: Record<
  AttentionLevel,
  { color: string; label: string; motion: string }
> = {
  "needs-you": { color: palette.red, label: "Needs you", motion: "animate-attention-ping" },
  working: { color: palette.green, label: "Working", motion: "animate-breathe" },
  done: { color: palette.purple, label: "Just finished", motion: "" },
  idle: { color: "var(--color-dot)", label: "Idle", motion: "" },
};

/** A status dot for one resolved attention level. */
export function AttentionDot({ level, size = 7 }: { level: AttentionLevel; size?: number }) {
  const meta = attentionMeta[level];
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className={`relative flex-none rounded-full ${meta.motion}`}
      // `color` as well as `background`: the ping ring is a pseudo-element filled
      // with currentColor.
      style={{ width: size, height: size, background: meta.color, color: meta.color }}
    />
  );
}
