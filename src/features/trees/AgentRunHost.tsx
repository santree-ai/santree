/** Turns queued agent launches into running agents, wherever the user happens to be.
 *
 *  Mounted at the app shell (`__root.tsx`), not in the Trees route: a "Run in
 *  background" launch from Issues never opens Trees, and a launch queued behind a
 *  setup run must survive navigating away. Two jobs:
 *
 *  1. Consume Issues' background-launch requests once their worktree actually exists
 *     (the create runs in parallel with the request).
 *  2. Start a *detached* session for every queued launch Trees isn't already showing:
 *     the PTY spawns and the agent seeds, but the session is never displayed. It is
 *     rendered — at a real size, like every other pane — inside the persistent
 *     `TerminalLayer`, so it needs no host of its own; claiming the layer's single
 *     inline slot would blank whatever terminal the user is currently watching.
 *     Once the agent has launched the flag clears and this unmounts; the session
 *     lives on in the layer and shows up when the worktree is next opened. */
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
 *  — see `RepoLaunches`), the worktree Trees currently shows (its visible pane
 *  already hosts that terminal — two hosts for one session would fight over the
 *  single xterm overlay), and any launch whose worktree isn't real yet (a
 *  placeholder has no path to root a terminal in). "Currently shows" is matched on
 *  project *and* id: two projects of one Linear org can hold a worktree for the
 *  same ticket, and skipping the wrong one silently drops the launch. Everything
 *  else runs here, which is what makes a launch survive both never opening Trees
 *  and navigating away from it. Exported for testing — see AgentRunHost.test.ts. */
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
        !(visibleWorktree?.repo === launch.repo && visibleWorktree.id === id),
    )
    .map(([id, launch]) => ({ worktree: worktrees.find((w) => w.id === id), tabId: launch.tabId }))
    .filter((x): x is { worktree: Worktree; tabId: string } => !!x.worktree && !x.worktree.pending);
}

export function AgentRunHost() {
  const { launchAgents } = useAgentRuns();
  const { bgLaunches } = useAppUi();
  // Nothing queued is the overwhelmingly common case — don't even observe the
  // worktrees query until there's a launch to host.
  if (launchAgents.size === 0 && bgLaunches.length === 0) return null;
  return <QueuedLaunches />;
}

/** One host per project with something queued in it. Split this way because
 *  every read below is per-project (`useWorktrees`, `useWorktreeTabs`) and hooks
 *  cannot be called in a loop — and because a queue that only ever looked at one
 *  project is a queue that silently drops a launch started in another, which is
 *  exactly what "run this in the background" must not do. */
function QueuedLaunches() {
  const { bgLaunches } = useAppUi();
  const { launchAgents } = useAgentRuns();
  const repos = [
    ...new Set([
      ...bgLaunches.map((l) => l.repo),
      ...[...launchAgents.values()].map((l) => l.repo),
    ]),
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
  const { bgLaunches, clearBackgroundLaunch } = useAppUi();
  const { launchAgents, visibleWorktree, beginRun } = useAgentRuns();
  const { data: worktrees = [] } = useWorktrees(repo);
  const { data: tabs = [] } = useWorktreeTabs(repo);
  const { mutate: addTabRow } = useAddWorktreeTab(repo);

  // A background launch is requested before its worktree exists, so wait for the
  // real one — a pending placeholder has no path to root a terminal in. Consuming
  // the request is one-shot: the launch/setup flags carry it from here. The tab is
  // minted and persisted first, exactly as a foreground start does it — an agent
  // that ran in no tab would be invisible when the worktree is next opened.
  useEffect(() => {
    for (const { repo: launchRepo, id } of bgLaunches) {
      if (launchRepo !== repo) continue;
      const wt = worktrees.find((w) => w.id === id);
      if (!wt || wt.pending) continue;
      clearBackgroundLaunch(id);
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
  }, [repo, bgLaunches, worktrees, tabs, addTabRow, beginRun, clearBackgroundLaunch]);

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
