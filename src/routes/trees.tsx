import { createFileRoute } from "@tanstack/react-router";

import { TreesView } from "../features/trees/TreesView";

export const Route = createFileRoute("/trees")({
  component: TreesView,
});
