import { createFileRoute } from "@tanstack/react-router";

import { SettingsView } from "../features/settings/SettingsView";

export const Route = createFileRoute("/settings")({
  // Optional `?section=` deep-links straight to a settings section (e.g. the
  // merge queue's "sign in to GitHub" opens Settings → GitHub).
  validateSearch: (search: Record<string, unknown>): { section?: string } => ({
    section: typeof search.section === "string" ? search.section : undefined,
  }),
  component: SettingsView,
});
