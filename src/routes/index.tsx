import { createFileRoute } from "@tanstack/react-router";

import { AgentsView } from "../features/agents/AgentsView";

export const Route = createFileRoute("/")({
  component: AgentsView,
});
