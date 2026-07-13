/** The main work-session terminal for a worktree — {@link useAgentTab} plus the
 *  bits only the *work* session has: the launch/setup flags that a started task
 *  sets, and the on-disk work prompt it opens with.
 *
 *  Reads its launch state from `AgentRuns` (the app shell), not from the Trees
 *  model, so it is equally correct for the off-screen launcher — which runs when
 *  Trees isn't mounted at all. */
import type { Worktree } from "../../bindings";
import { useWorkPrompt } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { useApp } from "../../state/AppContext";
import { BASE_ID, shouldHoldTerminal } from "./model";
import { useAgentTab } from "./useAgentTab";

export function useWorktreeAgent(worktree: Worktree) {
  const { activeRepo: repo } = useApp();
  const { launchAgents, launchModels, isSettingUp, isInitialSetup } = useAgentRuns();
  // The base-branch entry has no ticket — no agent launch, no setup, just a shell.
  const isBase = worktree.id === BASE_ID;

  // Only a freshly-started task launches the agent (see the launch flag in AgentRuns).
  const launching = launchAgents.has(worktree.id);
  const settingUp = isSettingUp(worktree.id);
  // Withhold the terminal ONLY during the very first setup (the one that precedes
  // the launch): the PTY doesn't exist yet, so it must wait for the env setup wrote.
  // A manual "Re-run setup" must NOT yank the already-running terminal.
  const initialSetup = isInitialSetup(worktree.id);

  // The opening prompt is rendered backend-side from the live ticket and written to
  // a file; the hook returns that file's PATH. Fetch it only for a fresh launch (and
  // past any initial setup) — a resume or a plain shell doesn't need it.
  const workPrompt = useWorkPrompt(repo, worktree.id, launching && !initialSetup);

  // Hold the terminal while the work prompt is still being written, even though the
  // session isn't being fetched yet — mounting in that window spawns a bare shell
  // and silently drops the launch.
  const hold = shouldHoldTerminal({ launching, initialSetup, promptFetched: workPrompt.isFetched });

  const tab = useAgentTab({
    repo,
    refId: `tree:${worktree.id}`,
    cwd: worktree.path,
    agent: worktree.agent,
    allowFresh: launching,
    hold,
    shellOnly: isBase,
    // Seed the short "read the file" instruction rather than the prompt text: the
    // rendered work prompt can be huge, and typing it into the interactive-shell seed
    // overflows the line and gets mangled by the PTY's line editor. The file is
    // written before its path resolves, so it exists by the time we seed. The
    // one-liner is only a fallback for the window where the path is still loading.
    prompt: workPrompt.data
      ? `Read ${workPrompt.data} and follow the instructions inside.`
      : `Work on ${worktree.id}: ${worktree.title}`,
    remoteControl: worktree.id,
    // The tray's per-launch choice wins over the configured default; either applies
    // only to a fresh launch (a resume carries the session's own model).
    modelOverride: launchModels[worktree.id],
  });

  return { ...tab, isBase, launching, settingUp, initialSetup, refId: `tree:${worktree.id}` };
}
