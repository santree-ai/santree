import { createFileRoute } from "@tanstack/react-router";

import { SettingsView } from "../features/settings/SettingsView";

export const Route = createFileRoute("/settings")({
  // Optional `?section=` deep-links straight to a settings section (e.g. the
  // merge queue's "sign in to GitHub" opens Settings → GitHub).
  // `?scope=repo` opens the per-repo settings instead of the user's, and
  // `?repo=` picks which repo (e.g. the Tickets page's "link a project").
  validateSearch: (
    search: Record<string, unknown>,
  ): { section?: string; scope?: "repo"; repo?: string } => ({
    section: typeof search.section === "string" ? search.section : undefined,
    scope: search.scope === "repo" ? "repo" : undefined,
    repo: typeof search.repo === "string" ? search.repo : undefined,
  }),
  component: SettingsView,
});
