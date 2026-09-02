/** The screenshots the site shows: real captures of the app in its screenshot
 * fixture mode (`src/dev/fixtures` in the app repo), so every pixel is the
 * real UI over an invented company. One entry per view; the hero cycles
 * through them and the feature rows each take one. */

export type ScreenId = "trees" | "queue" | "tickets" | "triage" | "reviews";

export interface Screen {
  id: ScreenId;
  /** The pill label in the hero switcher. */
  label: string;
  /** What the picture shows, for a screen reader. */
  alt: string;
  /** The one line under the hero window while this view is showing. */
  caption: string;
}

/** Every capture is the same 1520×950 window at 2×. */
export const SCREEN_W = 2304;
export const SCREEN_H = 1440;

export const SCREENS: Screen[] = [
  {
    id: "trees",
    label: "Trees",
    alt: "The workspace: a sidebar listing the triage queue and every project's worktrees with their agents' live state, a Claude Code session fixing a Safari rendering bug in its own worktree, and the branch's changes ready to commit in the right panel.",
    caption:
      "One worktree per task. The agent works in a real terminal; the branch's changes wait beside it.",
  },
  {
    id: "queue",
    label: "Work queue",
    alt: "A worktree whose agent is asking permission to run a migration, beside the pull request's work queue: a failing check, a reviewer's comment and an AI draft, with a Start work button.",
    caption:
      "A failing check, a review comment and an AI draft become one queue. Start work hands it to an agent.",
  },
  {
    id: "tickets",
    label: "Tickets",
    alt: "The Tickets list grouped by project and milestone, each row marked ready or blocked, with pull request chips, cycle and estimate signals, and the selected ticket open in the right panel.",
    caption: "Your Linear queue, grouped by project and milestone. Every row says what blocks it.",
  },
  {
    id: "triage",
    label: "Triage",
    alt: "A triage ticket open beside an investigating agent's tab, with the attached project's files in the right panel and the rotation and SLA queue in the sidebar.",
    caption:
      "The rotation and the SLA clock live in the sidebar. Open a ticket and an agent starts digging.",
  },
  {
    id: "reviews",
    label: "Reviews",
    alt: "A teammate's pull request: the conversation with tab counts for commits, checks and files changed, an AI review session in a second tab, and the linked ticket in the right panel.",
    caption: "Other people's PRs, with an AI review that drafts comments you publish, or don't.",
  },
];

export const screenSrc = (id: ScreenId) => `/screens/${id}.webp`;
