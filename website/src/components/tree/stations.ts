/**
 * The five stops of the scroll, one ticket's life (QK-138, model.ts) from
 * triage to main, each with the real capture of the view that stage
 * happens in. The captures are the app in its screenshot fixture mode
 * (src/dev/fixtures in the app repo): every pixel is the real UI over an
 * invented company. Every capture is the same 1520×950 window at 2×.
 *
 * The copy states what the code does. Where it names a mechanism, the source:
 * - Investigate: src/features/triage/TriageView.tsx, src-tauri/prompts/triage.njk
 *   (runs on the main checkout, stops at a proposed comment).
 * - Run / Select Ready / Launch: src/features/issues/IssuePanel.tsx,
 *   QueuePane.tsx; the prompt is worktree::work_prompt (src-tauri/src/
 *   worktree.rs) rendering issue.njk + work.njk.
 * - Agent state from hooks: crates/hook, src/components/shell/AttentionDot.tsx.
 * - The PR work queue and Start work: src/features/reviews/ReviewWorklist.tsx,
 *   review_ai::fix_prompt rendering pr-fix.njk.
 * - AI review drafts stay local: src-tauri/src/review_ai.rs, hooks.rs.
 */

export type ScreenId = "trees" | "queue" | "tickets" | "triage" | "reviews";

export interface Station {
  id: string;
  name: string;
  /** The line of app text that stage leaves behind, in mono. */
  trace: string;
  title: string;
  body: string;
  screen: ScreenId;
  alt: string;
}

export const SCREEN_W = 2304;
export const SCREEN_H = 1440;
export const screenSrc = (id: ScreenId) => `/screens/${id}.webp`;

export const STATIONS: Station[] = [
  {
    id: "triage",
    name: "Triage",
    trace: "Investigate with Claude Code   ⌘I",
    title: "Triage starts from the ticket.",
    body: "Investigate hands a triage ticket, screenshots included, to Claude Code or Codex on main. It works through the code and stops at a proposed comment. The SLA clock and the rotation sit in the sidebar.",
    screen: "triage",
    alt: "A triage ticket open beside an investigating agent's tab, with the attached project's files in the right panel and the rotation and SLA queue in the sidebar.",
  },
  {
    id: "branch",
    name: "Branch",
    trace: "Read the prompt file and follow the instructions inside.",
    title: "Run, and the ticket becomes the prompt.",
    body: "santree writes the ticket, its whole comment thread and your notes into the agent's opening prompt, creates the worktree and starts it. Select Ready launches every ready ticket the same way.",
    screen: "tickets",
    alt: "The Tickets list grouped by project and milestone, each row marked ready or blocked, with pull request chips, cycle and estimate signals, and the selected ticket open in the right panel.",
  },
  {
    id: "steer",
    name: "Steer",
    trace: "Allow Bash(pnpm db:migrate --dry-run)?",
    title: "You type only when it asks.",
    body: "Each agent runs in a real terminal you can type into. Its hooks report what it is doing, so the dot beside each tree says which one is working and which one needs you.",
    screen: "trees",
    alt: "The workspace: a sidebar listing the triage queue and every project's worktrees with their agents' live state, a Claude Code session fixing a Safari rendering bug in its own worktree, and the branch's changes ready to commit in the right panel.",
  },
  {
    id: "review",
    name: "Review",
    trace: "Start work",
    title: "Review comes back as the next prompt.",
    body: "Add a failing check, a reviewer's comment or an AI draft to the PR's queue. Start work writes them into one prompt, each thread as it reads now, and the agent ticks each item off.",
    screen: "queue",
    alt: "A worktree whose agent is asking permission to run a migration, beside the pull request's work queue: a failing check, a reviewer's comment and an AI draft, with a Start work button.",
  },
  {
    id: "ship",
    name: "Ship",
    trace: "merge sam/qk-138-migrate-quack-events",
    title: "Merge it and delete the tree.",
    body: "Your own checkout never moved. Teammates' PRs get an AI review too, and its draft comments stay on your machine until you publish them.",
    screen: "reviews",
    alt: "A teammate's pull request: the conversation with tab counts for commits, checks and files changed, an AI review session in a second tab, and the linked ticket in the right panel.",
  },
];

/**
 * QK-138's opening prompt as santree renders it: issue.njk inside work.njk
 * (src-tauri/prompts/), over the fixture ticket (src/dev/fixtures/world.ts).
 * Shortened only where marked; the wording is the templates'.
 */
export const PROMPT = {
  file: "work.njk · QK-138",
  lines: [
    { k: "dim", t: "<ticket-content>" },
    { k: "head", t: "## Linear Issue: QK-138" },
    { k: "strong", t: "**Migrate quack events to the pond_v2 schema**" },
    { k: "dim", t: "Status: Todo | Priority: Urgent | Labels: migration" },
    { k: "head", t: "### Description" },
    { k: "", t: "Move the `quack_events` table onto the `pond_v2` schema" },
    { k: "", t: "and backfill the last 90 days." },
    { k: "dim", t: "…" },
    { k: "dim", t: "- [ ] Backfill job (batched, resumable)" },
    { k: "head", t: "### Comments" },
    { k: "strong", t: "**Ada Featherstone**" },
    { k: "", t: "Should the backfill run in batches? 40k ponds in one" },
    { k: "", t: "transaction worries me." },
    { k: "dim", t: "</ticket-content>" },
    { k: "", t: "Review the codebase to understand the relevant areas and" },
    { k: "", t: "existing patterns." },
    { k: "", t: "Create an implementation plan, then implement the changes." },
  ],
} as const;
