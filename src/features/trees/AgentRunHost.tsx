/** Turns queued agent launches into running agents, wherever the user happens to be.
 *
 *  Mounted at the app shell (`__root.tsx`), not in the Trees route: a "Run in
 *  background" launch from Issues never opens Trees, and a launch queued behind a
 *  setup run must survive navigating away. Two jobs:
 *
 *  1. Consume Issues' background-launch requests once their worktree actually exists
 *     (the create runs in parallel with the request).
 *  2. Host an off-screen terminal for every queued launch Trees isn't already
 *     showing. The terminal renders at a real size — a `display:none` host gives
 *     xterm a 0-row grid — but parked off-screen, so the PTY spawns and the agent
 *     seeds without stealing focus. Once the agent has launched, the flag clears and
 *     this unmounts; the session lives on in the `TerminalLayer` and re-attaches when
 *     the worktree is next opened. */
import { useEffect } from "react";

import type { Worktree } from "../../bindings";
import { useWorktrees } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { useApp, useAppUi } from "../../state/AppContext";
import { useWorktreeAgent } from "./useWorktreeAgent";
import { WorktreeTerminal } from "./WorktreeTerminal";

/** Which queued launches this host must run off-screen.
 *
 *  Excluded: the worktree Trees currently shows (its visible pane already hosts that
 *  terminal — two hosts for one session would fight over the single xterm overlay),
 *  and any launch whose worktree isn't real yet (a placeholder has no path to root a
 *  terminal in). Everything else runs here, which is what makes a launch survive both
 *  never opening Trees and navigating away from it. Exported for testing — see
 *  AgentRunHost.test.ts. */
export function launchesToHost(
  launchAgents: Set<string>,
  worktrees: Worktree[],
  visibleWorktree: string | null,
): Worktree[] {
  return [...launchAgents]
    .filter((id) => id !== visibleWorktree)
    .map((id) => worktrees.find((w) => w.id === id))
    .filter((w): w is Worktree => !!w && !w.pending);
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

  // A background launch is requested before its worktree exists, so wait for the
  // real one — a pending placeholder has no path to root a terminal in. Consuming
  // the request is one-shot: the launch/setup flags carry it from here.
  useEffect(() => {
    for (const id of bgLaunches) {
      const wt = worktrees.find((w) => w.id === id);
      if (!wt || wt.pending) continue;
      clearBackgroundLaunch(id);
      beginRun(id);
    }
  }, [bgLaunches, worktrees, beginRun, clearBackgroundLaunch]);

  return (
    <>
      {launchesToHost(launchAgents, worktrees, visibleWorktree).map((wt) => (
        <OffscreenLaunch key={wt.id} worktree={wt} />
      ))}
    </>
  );
}

/** One off-screen agent terminal for a queued launch. */
function OffscreenLaunch({ worktree }: { worktree: Worktree }) {
  const { clearAgentLaunch } = useAgentRuns();
  const { launching, initialSetup, preparing, seed, onExited } = useWorktreeAgent(worktree);

  // The same gate the visible pane uses: don't spawn the PTY until every seed input
  // has resolved. Mounting early spawns a bare shell and drops the agent launch.
  if (!launching || initialSetup || preparing) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 -z-50 h-[600px] w-[900px] overflow-hidden opacity-0"
      style={{ transform: "translateX(-100000px)" }}
    >
      <WorktreeTerminal
        id={worktree.id}
        branch={worktree.branch}
        cwd={worktree.path}
        seed={seed}
        onLaunched={() => clearAgentLaunch(worktree.id)}
        onExited={onExited}
      />
    </div>
  );
}
