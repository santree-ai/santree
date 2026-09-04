import { createFileRoute } from "@tanstack/react-router";

import { TreesView } from "../features/trees/TreesView";

export const Route = createFileRoute("/trees")({
  // `?project=` is the registered project whose worktree is open, and `?tree=`
  // is the worktree itself. Both live in the route for the reason Reviews'
  // `?project=`/`?pr=` do: the sidebar is permanent and this view is not, so a
  // selection held inside the view leaves the rail lighting a row nobody picked.
  //
  // Together they replace what used to be a sticky global "active repo" mode —
  // a project you were silently *in*, carried across every navigation and
  // remembered between launches. That mode is what let a ticket start in the
  // wrong project: whatever was last active answered "where", and no setting
  // was ever consulted. A project is now a coordinate of the thing on screen,
  // absent when nothing is open (the welcome surface), and a reload lands back
  // on the same worktree as a consequence rather than as a second mechanism.
  validateSearch: (search: Record<string, unknown>): { project?: string; tree?: string } => ({
    project: typeof search.project === "string" && search.project ? search.project : undefined,
    tree: typeof search.tree === "string" && search.tree ? search.tree : undefined,
  }),
  component: TreesView,
});
