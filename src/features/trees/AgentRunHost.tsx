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
import { useAgentRuns } from "../../state/AgentRuns";
import { useApp, useAppUi } from "../../state/AppContext";
import { defaultTabTitle, remoteControlTab } from "./model";
import { useAgentTab } from "./useAgentTab";
import { useWorkLaunch } from "./useWorkLaunch";
import { WorktreeTerminal } from "./WorktreeTerminal";

/** Which queued launches this host must start detached, each paired with the tab
 *  it launches into.
 *
 *  Excluded: the worktree Trees currently shows (its visible pane already hosts that
 *  terminal — two hosts for one session would fight over the single xterm overlay),
 *  and any launch whose worktree isn't real yet (a placeholder has no path to root a
 *  terminal in). Everything else runs here, which is what makes a launch survive both
 *  never opening Trees and navigating away from it. Exported for testing — see
 *  AgentRunHost.test.ts. */
export function launchesToHost(
  launchAgents: ReadonlyMap<string, string>,
  worktrees: Worktree[],
  visibleWorktree: string | null,
): { worktree: Worktree; tabId: string }[] {
  return [...launchAgents]
    .filter(([id]) => id !== visibleWorktree)
    .map(([id, tabId]) => ({ worktree: worktrees.find((w) => w.id === id), tabId }))
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

function QueuedLaunches() {
  const { activeRepo } = useApp();
  const { bgLaunches, clearBackgroundLaunch } = useAppUi();
  const { launchAgents, visibleWorktree, beginRun } = useAgentRuns();
  const { data: worktrees = [] } = useWorktrees(activeRepo);
  const { data: tabs = [] } = useWorktreeTabs(activeRepo);
  const { mutate: addTabRow } = useAddWorktreeTab(activeRepo);

  // A background launch is requested before its worktree exists, so wait for the
  // real one — a pending placeholder has no path to root a terminal in. Consuming
  // the request is one-shot: the launch/setup flags carry it from here. The tab is
  // minted and persisted first, exactly as a foreground start does it — an agent
  // that ran in no tab would be invisible when the worktree is next opened.
  useEffect(() => {
    for (const id of bgLaunches) {
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
      beginRun(id, tabId);
    }
  }, [bgLaunches, worktrees, tabs, addTabRow, beginRun, clearBackgroundLaunch]);

  return (
    <>
      {launchesToHost(launchAgents, worktrees, visibleWorktree).map(({ worktree, tabId }) => (
        <DetachedLaunch key={worktree.id} worktree={worktree} tabId={tabId} />
      ))}
    </>
  );
}

/** One detached agent session for a queued launch: spawned and seeded, rendered
 *  nowhere. `attach={false}` is what keeps it off the layer's inline slot. */
function DetachedLaunch({ worktree, tabId }: { worktree: Worktree; tabId: string }) {
  const { activeRepo: repo } = useApp();
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
