import type { DemoView } from "~/components/app-demo";

/** The four feature rows, mapped 1:1 to the app's real views. `color` is the
 * agent-status color the section's spine node lights up in. */
export interface Feature {
  id: DemoView;
  kicker: string;
  title: string;
  body: string;
  extra?: string;
  color: string;
}

export const FEATURES: Feature[] = [
  {
    id: "triage",
    kicker: "triage",
    title: "Read the ticket, hand it off.",
    body: "The queue where tickets become assignments. Pull issues straight from Linear, keep the SLA clock honest, and hand the right ones to an agent without leaving the keyboard.",
    color: "#4493f8",
  },
  {
    id: "issues",
    kicker: "issues",
    title: "Your tickets are a dependency graph.",
    body: "Tickets are a DAG, so santree draws one. Know what unblocks what, launch agents in the right order, and chain a ticket's branch off its blocker's.",
    color: "#a78bfa",
  },
  {
    id: "trees",
    kicker: "trees",
    title: "Every agent gets its own worktree.",
    body: "This is the view you'll live in. Each agent works in an isolated git worktree with an embedded terminal you can watch, interrupt, and redirect.",
    extra: "No stash. No stepping on your own diff. Kill a tree, keep your repo.",
    color: "#2dd4a7",
  },
  {
    id: "reviews",
    kicker: "reviews",
    title: "A co-reviewer that already read the diff.",
    body: "A PR dashboard with an AI companion that already read the diff. Inline comments, batched reviews, and check logs, without opening a browser tab.",
    extra: "Agents write the code. You still own the merge button.",
    color: "#3fb950",
  },
];
