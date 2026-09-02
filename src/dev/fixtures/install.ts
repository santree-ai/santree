/**
 * Turn the fixture mode on: open a pane for every fake agent and put the app
 * on the scene the next capture wants — before React mounts, so the first
 * render is already the picture. The commands themselves are answered by
 * `tauriCore.ts`, which the Vite alias seats in place of `@tauri-apps/api/core`.
 */
import type { TerminalSpec } from "../../features/terminal/orchestrator";
import { SCENE, type Scene } from "./scene";
import { AGENTS, TABS, worktreePath } from "./world";

/** Every fake agent as a pane, plus the shell tab beside the hero worktree, so
 *  the sidebar sees them all live from the first paint (see `fixtureSeam.ts`). */
function terminalSpecs(): TerminalSpec[] {
  const agents = AGENTS.map<TerminalSpec>((a) => ({
    title: a.title,
    cwd: a.cwd,
    command: "",
    source: a.source,
    refId: a.termKey,
    agent: { kind: a.kind, repo: a.repo, termKey: a.termKey },
  }));
  const shells = TABS.filter((t) => t.kind === "terminal").map<TerminalSpec>((t) => ({
    title: t.title,
    cwd: worktreePath("mallard-labs/quackstack", t.worktreeId),
    command: "",
    source: "issue",
    refId: `tree:${t.worktreeId}:tab:${t.id}`,
  }));
  return [...agents, ...shells];
}

/** Write the scene into the storage the app reads its view state from. Keys
 *  are the app's own (`AppContext`, the Trees model, the sidebar tree). */
function applyScene(scene: Scene) {
  const local = localStorage;
  const json = (v: unknown) => JSON.stringify(v);
  local.setItem("santree-theme", scene.theme);
  local.setItem("santree-active-repo", scene.activeRepo);
  local.setItem("santree-sidebar-collapsed", "false");
  local.setItem("santree-sidebar-width", String(scene.sidebarWidth));

  sessionStorage.setItem("santree-trees-active-id", json(scene.trees.activeId));
  local.setItem("santree-trees-right-collapsed", json(false));
  local.setItem("santree-trees-right-width", json(scene.trees.rightWidth));
  local.setItem("santree-trees-file-tab-v5", json(scene.trees.pane));
  local.setItem("santree-trees-tab-by-worktree", json({ [scene.trees.activeId]: scene.trees.tab }));
  local.setItem("santree-trees-file-by-worktree", json({}));
  local.setItem("santree-trees-file-scope-by-wt", json({}));
  local.setItem(
    "santree-trees-pr-view-by-worktree",
    json(scene.trees.tab === "prView" ? { [scene.trees.activeId]: true } : {}),
  );
  local.setItem(
    "santree-trees-issue-view-by-worktree",
    json(scene.trees.tab === "issueView" ? { [scene.trees.activeId]: true } : {}),
  );

  local.setItem(
    "santree.shell.projectTree.collapsed",
    json(Object.fromEntries(scene.collapsedRepos.map((repo) => [`repo:${repo}`, true]))),
  );
  local.setItem("santree.shell.triage.collapsed", json(false));
  local.setItem("santree.shell.triage.snoozedOpen", json(false));
  // Nothing acknowledged: a finished agent reads as "just finished".
  local.setItem("santree.agents.seenAt", json({}));
  local.setItem("santree.tickets.mode", json(scene.tickets.mode));
  local.setItem("santree.tickets.actionableOnly", json(false));

  const here = `${location.pathname}${location.search}`;
  if (here !== scene.route) history.replaceState(null, "", scene.route);
}

export async function installFixtures(): Promise<void> {
  globalThis.__santreeFixtureTerminals = terminalSpecs();
  applyScene(SCENE);
  console.info("[santree] fixture mode on:", SCENE.route, SCENE.theme);
}
