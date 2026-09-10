/** Turns launch requests into running agents, wherever the user happens to be.
 *
 *  Mounted at the app shell (`__root.tsx`), not in the Trees route, because a
 *  start must not depend on what is on screen: a ⌘-click Run from the Tickets
 *  list never opens Trees, a launch queued behind a setup run must survive
 *  navigating away, and a task started while looking at another project — or
 *  at the new worktree's own empty surface — has to run all the same. Every
 *  start comes through here (see `LaunchRequest`). Two jobs:
 *
 *  1. Consume each request once its worktree actually exists (the create runs in
 *     parallel with the request): mint the tab the agent runs in and begin the
 *     run. Trees, when it shows that worktree, follows the run onto that tab.
 *  2. Start a *detached* session for every queued launch no view is hosting: the
 *     PTY spawns and the agent seeds, but the session is never displayed. It is
 *     rendered — at a real size, like every other pane — inside the persistent
 *     `TerminalLayer`, so it needs no host of its own; claiming the layer's single
 *     inline slot would blank whatever terminal the user is currently watching.
 *     Once the agent has launched the flag clears and this unmounts; the session
 *     lives on in the layer and shows up when its tab is next opened. */
import { useEffect } from "react";

import type { Worktree } from "../../bindings";
import { useAddWorktreeTab, useWorktrees, useWorktreeTabs } from "../../lib/queries";
import { type QueuedLaunch, useAgentRuns, type VisibleWorktree } from "../../state/AgentRuns";
import { useAppUi } from "../../state/AppContext";
import { defaultTabTitle, remoteControlTab } from "./model";
import { useAgentTab } from "./useAgentTab";
import { useWorkLaunch } from "./useWorkLaunch";
import { WorktreeTerminal } from "./WorktreeTerminal";

/** Which queued launches this host must start detached, each paired with the tab
 *  it launches into.
 *
 *  Excluded: launches belonging to another project (each project has its own host
 *  — see `RepoLaunches`), the launch whose *tab* a view has on screen (that pane
 *  already hosts the terminal — two hosts for one session would fight over the
 *  single xterm overlay), and any launch whose worktree isn't real yet (a
 *  placeholder has no path to root a terminal in). "On screen" is matched on
 *  project, id *and* tab: two projects of one Linear org can hold a worktree for
 *  the same ticket, and a worktree showing another of its tabs — or its empty
 *  surface, as a freshly created one does — mounts no pane for this launch, so
 *  skipping it is how a start ran nowhere until its tab was opened by hand.
 *  Everything else runs here, which is what makes a launch survive never opening
 *  Trees, navigating away from it, and looking at the wrong tab. Exported for
 *  testing — see AgentRunHost.test.ts. */
export function launchesToHost(
  launchAgents: ReadonlyMap<string, QueuedLaunch>,
  repo: string,
  worktrees: Worktree[],
  visibleWorktree: VisibleWorktree | null,
): { worktree: Worktree; tabId: string }[] {
  return [...launchAgents]
    .filter(
      ([id, launch]) =>
        launch.repo === repo &&
        !(
          visibleWorktree?.repo === launch.repo &&
          visibleWorktree.id === id &&
          visibleWorktree.tab === launch.tabId
        ),
    )
    .map(([id, launch]) => ({ worktree: worktrees.find((w) => w.id === id), tabId: launch.tabId }))
    .filter((x): x is { worktree: Worktree; tabId: string } => !!x.worktree && !x.worktree.pending);
}

export function AgentRunHost() {
  const { launchAgents } = useAgentRuns();
  const { launches } = useAppUi();
  // Nothing queued is the overwhelmingly common case — don't even observe the
  // worktrees query until there's a launch to host.
  if (launchAgents.size === 0 && launches.length === 0) return null;
  return <QueuedLaunches />;
}

/** One host per project with something queued in it. Split this way because
 *  every read below is per-project (`useWorktrees`, `useWorktreeTabs`) and hooks
 *  cannot be called in a loop — and because a queue that only ever looked at one
 *  project is a queue that silently drops a launch started in another, which is
 *  exactly what "run this in the background" must not do. */
function QueuedLaunches() {
  const { launches } = useAppUi();
  const { launchAgents } = useAgentRuns();
  const repos = [
    ...new Set([...launches.map((l) => l.repo), ...[...launchAgents.values()].map((l) => l.repo)]),
  ];
  return (
    <>
      {repos.map((repo) => (
        <RepoLaunches key={repo} repo={repo} />
      ))}
    </>
  );
}

function RepoLaunches({ repo }: { repo: string }) {
  const { launches, clearLaunch } = useAppUi();
  const { launchAgents, visibleWorktree, beginRun } = useAgentRuns();
  const { data: worktrees = [] } = useWorktrees(repo);
  const { data: tabs = [] } = useWorktreeTabs(repo);
  const { mutate: addTabRow } = useAddWorktreeTab(repo);

  // A launch is requested before its worktree exists, so wait for the real one —
  // a pending placeholder has no path to root a terminal in. Consuming the
  // request is one-shot: the launch/setup flags carry it from here. The tab is
  // minted and persisted first — the run names it, and an agent that ran in no
  // tab would be invisible when the worktree is next opened.
  useEffect(() => {
    for (const { repo: launchRepo, id } of launches) {
      if (launchRepo !== repo) continue;
      const wt = worktrees.find((w) => w.id === id);
      if (!wt || wt.pending) continue;
      clearLaunch(id);
      const tabId = crypto.randomUUID();
      const agent = wt.agent ?? "Claude";
      addTabRow({
        id: tabId,
        worktreeId: id,
        kind: "agent",
        agentKind: agent,
        title: defaultTabTitle(
          "agent",
          agent,
          tabs.filter((t) => t.worktreeId === id),
        ),
        pr: null,
      });
      beginRun(repo, id, tabId);
    }
  }, [repo, launches, worktrees, tabs, addTabRow, beginRun, clearLaunch]);

  return (
    <>
      {launchesToHost(launchAgents, repo, worktrees, visibleWorktree).map(({ worktree, tabId }) => (
        <DetachedLaunch key={worktree.id} repo={repo} worktree={worktree} tabId={tabId} />
      ))}
    </>
  );
}

/** One detached agent session for a queued launch: spawned and seeded, rendered
 *  nowhere. `attach={false}` is what keeps it off the layer's inline slot. */
function DetachedLaunch({
  repo,
  worktree,
  tabId,
}: {
  repo: string;
  worktree: Worktree;
  tabId: string;
}) {
  const { clearAgentLaunch } = useAgentRuns();
  const { data: allTabs = [] } = useWorktreeTabs(repo);
  const tabs = allTabs.filter((t) => t.worktreeId === worktree.id);
  const work = useWorkLaunch(repo, worktree, tabId);
  const { preparing, seed, onExited, agent } = useAgentTab({
    repo,
    refId: `tree:${worktree.id}:tab:${tabId}`,
    cwd: worktree.path,
    agent: worktree.agent,
    allowFresh: true,
    hold: work.hold,
    prompt: work.prompt,
    // The same one-claim-per-worktree rule the visible pane applies.
    remoteControl: remoteControlTab(tabs) === tabId ? worktree.id : undefined,
  });

  // The same gate the visible pane uses: don't spawn the PTY until every seed input
  // has resolved. Mounting early spawns a bare shell and drops the agent launch.
  if (!work.launching || work.initialSetup || preparing) return null;

  return (
    <WorktreeTerminal
      id={`${worktree.id}:tab:${tabId}`}
      branch={worktree.branch}
      cwd={worktree.path}
      seed={seed}
      agent={agent}
      attach={false}
      onLaunched={() => clearAgentLaunch(worktree.id)}
      onExited={onExited}
    />
  );
}
