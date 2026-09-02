/**
 * The one seam the screenshot fixture layer (`src/dev/fixtures`) has into the
 * app's own state: which panes to open at startup.
 *
 * The agent registry only calls a session *live* when a terminal tab for it is
 * open in this page (`liveTabFor`), and a tab only exists once a pane has
 * mounted and asked for one. A fixture world with agents on five worktrees
 * therefore needs those five panes open from the first render — visited or not
 * — which nothing outside React can arrange after the fact. So the provider
 * reads its initial specs from here.
 *
 * Dev-only by construction: `import.meta.env.DEV` is a build-time constant, so a
 * production bundle compiles this to an empty list and the fixture layer never
 * ships. Everywhere else it is empty too unless the fixture installer ran first
 * (`VITE_SANTREE_FIXTURES=1`), which is the only writer of the global.
 */
import type { TerminalSpec } from "./orchestrator";

declare global {
  var __santreeFixtureTerminals: TerminalSpec[] | undefined;
}

export function fixtureTerminalSpecs(): TerminalSpec[] {
  if (!import.meta.env.DEV) return [];
  return globalThis.__santreeFixtureTerminals ?? [];
}
