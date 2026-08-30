import { createFileRoute } from "@tanstack/react-router";

import { TicketsView } from "../features/tickets/TicketsView";

export const Route = createFileRoute("/issues")({
  component: TicketsView,
});
