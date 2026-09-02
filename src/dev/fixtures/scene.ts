/**
 * What the next capture shows. Edit and save: Vite reloads the page, the
 * installer re-applies the scene before React mounts, and the window lands on
 * it — no keystrokes into the app, nothing to click.
 *
 * Every field maps onto state the app already persists (the route, the theme,
 * the active repo, the Trees selection and its right-panel pane), written to
 * the same storage keys the app reads them from.
 */
export type SceneRoute =
  | "/trees"
  | "/issues"
  | `/triage?ticket=${string}`
  | `/reviews?project=${string}&pr=${string}`;

export interface Scene {
  theme: "dark" | "light";
  route: SceneRoute;
  activeRepo: string;
  /** Trees: the selected worktree (a ticket id, or `__base__`), its right-panel
   *  pane and the main tab showing. */
  trees: {
    activeId: string;
    pane: "issue" | "files" | "changes" | "history" | "pr" | "aiWork";
    tab: `tab:${string}` | "prView" | "issueView";
    rightWidth: number;
  };
  tickets: { mode: "list" | "graph" };
  sidebarWidth: number;
  /** Repo sections left folded in the sidebar. */
  collapsedRepos: string[];
}

export const SCENE: Scene = {
  theme: "dark",
  route: "/trees",
  activeRepo: "mallard-labs/quackstack",
  trees: { activeId: "QK-142", pane: "changes", tab: "tab:t-142a", rightWidth: 320 },
  tickets: { mode: "list" },
  sidebarWidth: 296,
  collapsedRepos: ["mallard-labs/pond-infra", "mallard-labs/beak-cli"],
};
