import { createFileRoute } from "@tanstack/react-router";

import { TerminalSurface } from "../features/terminal/TerminalSurface";

export const Route = createFileRoute("/terminal")({
  component: TerminalSurface,
});
