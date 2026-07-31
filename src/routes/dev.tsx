import { createFileRoute } from "@tanstack/react-router";

import { DevView } from "../features/dev/DevView";

export const Route = createFileRoute("/dev")({
  component: DevView,
});
