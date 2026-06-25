import { createFileRoute } from "@tanstack/react-router";

import { TriageView } from "../features/triage/TriageView";

export const Route = createFileRoute("/triage")({
  component: TriageView,
});
