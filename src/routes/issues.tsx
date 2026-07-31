import { createFileRoute } from "@tanstack/react-router";

import { IssuesView } from "../features/issues/IssuesView";

export const Route = createFileRoute("/issues")({
  component: IssuesView,
});
