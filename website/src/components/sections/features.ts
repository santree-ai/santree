import type { ScreenId } from "~/components/screens";

/** The feature rows, each over one real capture. `color` is the agent-status
 * color the row's kicker wears. */
export interface Feature {
  id: ScreenId;
  kicker: string;
  title: string;
  body: string;
  extra?: string;
  color: string;
}

export const FEATURES: Feature[] = [
  {
    id: "trees",
    kicker: "trees",
    title: "Every agent gets its own worktree.",
    body: "This is the view you'll live in. Each task is an isolated git worktree with a tab per agent or shell, and the ticket, the files, the branch's changes and the session history one click to the right.",
    extra: "No stash. No stepping on your own diff. Delete a tree, keep your repo.",
    color: "#2dd4a7",
  },
  {
    id: "tickets",
    kicker: "tickets",
    title: "Your backlog knows what's ready.",
    body: "Tickets from Linear, grouped by project and milestone, or drawn as the dependency graph they are. Every row says whether it's ready or what blocks it. Run one, or queue several and launch them together, each with its own agent.",
    color: "#a78bfa",
  },
  {
    id: "triage",
    kicker: "triage",
    title: "Triage lives in the sidebar.",
    body: "Who's on rotation, the tickets waiting with their SLA, a snoozed group. Open one and it gets a workspace: the ticket, an agent already reading it, a shell. All on the project's main checkout, no worktree created.",
    color: "#4493f8",
  },
  {
    id: "reviews",
    kicker: "reviews",
    title: "A co-reviewer that already read the diff.",
    body: "Other people's pull requests, per project, ordered by what needs you. An AI review writes a brief and drafts inline comments that stay on your machine until you publish them. Nothing an agent writes reaches GitHub without your click.",
    color: "#3fb950",
  },
  {
    id: "queue",
    kicker: "the work queue",
    title: "Failing checks and review comments become the next task.",
    body: "Your own PR is worked on beside its worktree. A red check, a reviewer's comment, an AI draft or a diff line you flag all land in one queue, and Start work hands the whole thing to an agent.",
    extra: "Agents write the code. You still own the merge button.",
    color: "#d29922",
  },
];
