/**
 * The five stops of the scroll, one ticket's life from triage to merge, each
 * with the real capture of the view that stage happens in. The captures are
 * the app in its screenshot fixture mode (src/dev/fixtures in the app repo):
 * every pixel is the real UI over an invented company. Each is the same
 * 2304×1440 window at 2×, cropped here to the part that stage is about, so the
 * text in it stays readable at the size it is shown.
 *
 * The copy names no tracker, code host or agent: which ones santree supports
 * changes, and /docs#supported is the one place that lists them. The captures
 * show provider names inside the product's own UI, which is the product.
 *
 * The copy states what the code does. Where it names a mechanism, the source:
 * - Investigate / triage: src/features/triage/TriageView.tsx,
 *   src-tauri/prompts/triage.njk (runs on the main checkout, stops at a
 *   proposed comment).
 * - Run / Select Ready / Launch: src/features/issues/IssuePanel.tsx,
 *   QueuePane.tsx; the prompt is worktree::work_prompt (src-tauri/src/
 *   worktree.rs) rendering issue.njk + work.njk.
 * - Agent state: crates/hook, src/components/shell/AttentionDot.tsx.
 * - The PR work queue and Start work: src/features/reviews/ReviewWorklist.tsx,
 *   review_ai::fix_prompt rendering pr-fix.njk.
 * - AI review drafts stay local: src-tauri/src/review_ai.rs, hooks.rs.
 */

export type ScreenId = "queue" | "tickets" | "triage" | "reviews";

/** The part of a capture a station shows, as fractions of its width and height. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Station {
  id: string;
  name: string;
  title: string;
  body: string;
  screen: ScreenId;
  crop: Crop;
  /** A tighter crop for the stacked layout, where the capture is a phone's width. */
  list: Crop;
  alt: string;
}

export const SCREEN_W = 2304;
export const SCREEN_H = 1440;
export const screenSrc = (id: ScreenId) => `/screens/${id}.webp`;
/** The crop's aspect ratio, width over height, in captured pixels. */
export const cropAspect = (c: Crop) => (c.w * SCREEN_W) / (c.h * SCREEN_H);

export const STATIONS: Station[] = [
  {
    id: "triage",
    name: "Triage",
    title: "Triage starts from the ticket.",
    body: "Investigate hands a triage ticket, screenshots included, to an agent on main. It works through the code and stops at a proposed comment. The SLA clock and the rotation sit in the sidebar.",
    screen: "triage",
    crop: { x: 0.195, y: 0.045, w: 0.545, h: 0.67 },
    list: { x: 0.2, y: 0.045, w: 0.5, h: 0.34 },
    alt: "A triage ticket: its description, a stack trace and a comment, with the Investigate button beside Open Issue.",
  },
  {
    id: "run",
    name: "Run",
    title: "Run, and the ticket becomes the prompt.",
    body: "santree writes the ticket, its whole comment thread and your notes into the agent's opening prompt, creates the worktree and starts it. Select Ready launches every ready ticket the same way.",
    screen: "tickets",
    crop: { x: 0.195, y: 0.035, w: 0.6, h: 0.5 },
    list: { x: 0.2, y: 0.04, w: 0.5, h: 0.3 },
    alt: "The Tickets list grouped by project and milestone, each row marked ready or blocked, with the selected ticket open in the right panel.",
  },
  {
    id: "steer",
    name: "Steer",
    title: "You type only when it asks.",
    body: "Each agent runs in a real terminal you can type into. santree starts it, so it hears what the agent is doing without being told: the dot beside each tree says which agent is working and which one needs you.",
    screen: "queue",
    crop: { x: 0, y: 0.43, w: 0.78, h: 0.4 },
    list: { x: 0, y: 0.42, w: 0.55, h: 0.38 },
    alt: "A worktree whose agent is asking permission to run a migration: the red dot beside its tree in the sidebar, and the prompt in its terminal.",
  },
  {
    id: "review",
    name: "Review",
    title: "Review comes back as the next prompt.",
    body: "Add a failing check, a reviewer's comment or an AI draft to the PR's queue. Start work writes them into one prompt, each thread as it reads now, and the agent ticks each item off.",
    screen: "queue",
    crop: { x: 0.195, y: 0.035, w: 0.805, h: 0.6 },
    list: { x: 0.5, y: 0.035, w: 0.5, h: 0.55 },
    alt: "The pull request's work queue: a failing check, a reviewer's comment and an AI draft, with a Start work button.",
  },
  {
    id: "merge",
    name: "Merge",
    title: "Merge it and delete the tree.",
    body: "Your own checkout never moved. Teammates' PRs get an AI review too, and its draft comments stay on your machine until you publish them.",
    screen: "reviews",
    crop: { x: 0.195, y: 0.035, w: 0.545, h: 0.6 },
    list: { x: 0.2, y: 0.035, w: 0.5, h: 0.4 },
    alt: "A teammate's pull request: the description, the conversation, and tabs for commits, checks and files changed.",
  },
];

/**
 * The ticket's opening prompt as santree renders it: issue.njk inside
 * work.njk (src-tauri/prompts/), over the fixture ticket (src/dev/fixtures/
 * world.ts). Shortened where marked with an ellipsis; the wording is the
 * templates'. The template's tracker line is left out: it names whichever
 * tracker the ticket came from.
 */
export const PROMPT = {
  file: "the opening prompt",
  lines: [
    { k: "dim", t: "<ticket-content>" },
    { k: "strong", t: "**Migrate quack events to the pond_v2 schema**" },
    { k: "dim", t: "Status: Todo | Priority: Urgent | Labels: migration" },
    { k: "head", t: "### Description" },
    { k: "", t: "Move the `quack_events` table onto the" },
    { k: "", t: "`pond_v2` schema and backfill the last 90 days." },
    { k: "dim", t: "…" },
    { k: "head", t: "### Comments" },
    { k: "strong", t: "**Ada Featherstone**" },
    { k: "", t: "Should the backfill run in batches? 40k" },
    { k: "", t: "ponds in one transaction worries me." },
    { k: "dim", t: "</ticket-content>" },
    { k: "", t: "Review the codebase to understand the" },
    { k: "", t: "relevant areas and existing patterns." },
    { k: "", t: "Create an implementation plan, then" },
    { k: "", t: "implement the changes." },
  ],
} as const;
