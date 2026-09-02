import { createFileRoute } from "@tanstack/react-router";

import { TriageView } from "../features/triage/TriageView";

export const Route = createFileRoute("/triage")({
  // `?ticket=` is the open ticket's id. It lives in the route rather than in
  // view state because two surfaces need it: the workspace, and the sidebar's
  // Triage section, which has to light up the row you are looking at — and the
  // sidebar is outside the view, so view state can't reach it. Nothing else
  // selects a ticket; a reload lands back on the same one as a consequence.
  validateSearch: (search: Record<string, unknown>): { ticket?: string } => ({
    ticket: typeof search.ticket === "string" && search.ticket ? search.ticket : undefined,
  }),
  component: TriageView,
});
