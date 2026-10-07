/**
 * The agent layer: what santree puts into a session that an agent cannot be
 * relied on to ask for, because santree starts the agent itself.
 *
 * MARKETING AHEAD OF CODE. As of 2026-10-07 the app does NOT have any of the
 * three things below (a live progress checklist, questions as native popups,
 * plans rendered readably): `git grep` of every branch finds none, and the
 * card in the Steer station is a redraw in the app's own colors, not a
 * capture. They are shown as shipped on the operator's decision. Verify them
 * against the app before a release, or revert the page by setting the flag
 * to false: the Steer station then falls back to the sentence the code backs,
 * and the card disappears. Nothing else reads these strings.
 */
export const AGENT_LAYER_SHIPPED = true;

export const STEER_BODY_PLAIN =
  "Each agent runs in a real terminal you can type into. santree starts it, so it hears what the agent is doing without being told: the dot beside each tree says which agent is working and which one needs you.";

export const STEER_BODY_LAYER =
  "Each agent runs in a real terminal you can type into. Because santree starts it, santree can add what an agent would never be asked for: a checklist that tracks the work as it happens, questions that arrive as popups instead of getting lost in a terminal, and plans set out to be read. The dot beside each tree says which one needs you.";

/** The redrawn card: the three additions, in the app's own palette (src/theme/colors.ts). */
export const LAYER = {
  head: "added by santree",
  progress: {
    label: "Progress",
    items: [
      { t: "Read the migration and its callers", s: "done" },
      { t: "Rewrite the backfill in batches", s: "doing" },
      { t: "Run the dry run against staging", s: "todo" },
    ],
  },
  question: {
    label: "Question",
    text: "Run the backfill in batches of 500?",
    yes: "Batch it",
    no: "Keep as is",
  },
  plan: {
    label: "Plan",
    steps: ["Batch by pond id", "Make it resumable", "Dry run, then apply"],
  },
} as const;
