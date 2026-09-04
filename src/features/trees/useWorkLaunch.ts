/** What a *started task's* tab opens with, on top of what every agent tab gets.
 *
 *  Starting a task mints a tab, writes its row and hands the run to `AgentRuns`
 *  (see the Trees model's `startAgent`). The launch names that tab, so exactly one
 *  pane can answer "this open is the task start" — which is what earns it the
 *  ticket's work prompt. Every other agent tab, including a later reopen of this
 *  one, is a plain conversation.
 *
 *  Reads its launch state from `AgentRuns` (the app shell) rather than from the
 *  Trees model, so it is equally correct for the off-screen launcher — which runs
 *  when Trees isn't mounted at all. */
import type { Worktree } from "../../bindings";
import { useWorkPrompt } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import { shouldHoldTerminal } from "./model";

export interface WorkLaunch {
  /** This tab is where a freshly started task's agent is launching. */
  launching: boolean;
  /** The *initial* setup — the one that precedes this launch — is still running.
   *  The pane shows that instead of a terminal: the PTY would otherwise capture
   *  the pre-setup env, and the agent seed only applies at session creation. A
   *  manual "Run setup" re-run is not this, and must not disturb a live terminal. */
  initialSetup: boolean;
  /** Hold the terminal back: a seed input is still resolving. */
  hold: boolean;
  /** The opening prompt, or undefined for a tab that isn't a task start. */
  prompt: string | undefined;
}

export function useWorkLaunch(repo: string, worktree: Worktree, tabId: string): WorkLaunch {
  const { launchAgents, isInitialSetup } = useAgentRuns();
  const launching = launchAgents.get(worktree.id)?.tabId === tabId;
  const initialSetup = launching && isInitialSetup(worktree.id);

  // The opening prompt is rendered backend-side from the live ticket and written to
  // a file; the hook returns that file's PATH. Fetch it only for a fresh launch (and
  // past any initial setup) — every other open needs nothing.
  const workPrompt = useWorkPrompt(repo, worktree.id, launching && !initialSetup);

  return {
    launching,
    initialSetup,
    // Hold while the work prompt is still being written, even though the session
    // isn't being fetched yet: mounting in that window spawns a bare shell and
    // silently drops the launch.
    hold:
      launching &&
      shouldHoldTerminal({ launching, initialSetup, promptFetched: workPrompt.isFetched }),
    // Seed the short "read the file" instruction rather than the prompt text: the
    // rendered work prompt can be huge, and typing it into the interactive-shell seed
    // overflows the line and gets mangled by the PTY's line editor. The file is
    // written before its path resolves, so it exists by the time we seed. The
    // one-liner is only a fallback for the window where the path is still loading.
    prompt: !launching
      ? undefined
      : workPrompt.data
        ? `Read ${workPrompt.data} and follow the instructions inside.`
        : `Work on ${worktree.id}: ${worktree.title}`,
  };
}
