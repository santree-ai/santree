/** The main work-session terminal state for a worktree — the seed pipeline shared
 *  by the visible `WorktreePane` and the off-screen `BackgroundLaunch`. Resolves
 *  how to (re)launch the agent (resume an on-disk session, start fresh, or a plain
 *  shell), builds the one-shot `seed` command, and reports when the terminal must
 *  be held back (setup running / prompt still fetching) so it never spawns a bare
 *  shell ahead of the agent. Reads all launch state from the Trees model by id, so
 *  it's correct for a background worktree that isn't the active one. */
import { useEffect, useState } from "react";

import type { Worktree } from "../../bindings";
import {
  CLAUDE_START_WITH_CHROME_KEY,
  useAgentSession,
  useBoolSetting,
  useClaudeHookSettings,
  useResolvedSetting,
  useWorkPrompt,
  WORK_EFFORT_KEY,
  WORK_MODEL_KEY,
  WORK_PERMISSION_MODE_KEY,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { BASE_ID, shouldHoldTerminal, useTrees } from "./model";

export function useWorktreeAgent(worktree: Worktree) {
  const { repo, launchAgents, launchModels, setupFor, setupThenLaunch } = useTrees();
  const { settings } = useApp();
  // The base-branch entry has no ticket — no agent launch/setup.
  const isBase = worktree.id === BASE_ID;

  // Only freshly-started tasks launch the agent (see the launch-flag in the model).
  const launching = launchAgents.has(worktree.id);
  const settingUp = setupFor === worktree.id;
  // Withhold the terminal ONLY during the very first setup (part of starting the
  // task) — the PTY doesn't exist yet, so it must wait for the env. A manual
  // "Re-run setup" later must NOT yank/restart the already-running terminal.
  const initialSetup = settingUp && setupThenLaunch;

  // The agent's opening prompt is rendered by the backend (`work` template) and
  // written to a file; the hook returns that file's PATH (see `useWorkPrompt`).
  // Fetch it only for a fresh launch (and past any initial setup); a resume/shell
  // don't need it.
  const workPrompt = useWorkPrompt(repo, worktree.id, launching && !initialSetup);
  const promptReady = !launching || workPrompt.isFetched;

  // Whether a live PTY already exists for this worktree. We only resolve a
  // (re)launch when there's none to attach to — and we latch `liveSeen` so that
  // quitting the agent (the session dies under us) doesn't immediately re-resume
  // it into a restart loop.
  const refId = `tree:${worktree.id}`;
  const { tabs } = useTerminals();
  const liveSession = tabs.some((t) => t.source === "issue" && t.refId === refId);
  const [liveSeen, setLiveSeen] = useState(false);
  useEffect(() => {
    if (liveSession) setLiveSeen(true);
  }, [liveSession]);
  // The main work session ran and has since exited (vs. never launched yet) — show
  // the resume placeholder instead of a blank/dead terminal. Never for the base
  // entry (a plain shell, no agent session to resume).
  const ended = !isBase && liveSeen && !liveSession;

  // Resolve how to (re)launch the agent: resume a still-on-disk session, start
  // fresh with a reserved id, or a plain shell. A passive reopen (not launching)
  // only resumes; an explicit launch may mint a fresh session.
  const needsSeed = !isBase && !initialSetup && promptReady && !liveSession && !liveSeen;
  const session = useAgentSession(repo, refId, worktree.path, launching, needsSeed);
  const exec = settings?.agents?.find((a) => a.key === worktree.agent)?.exec?.trim() || "claude";
  // The Work action's configured model + effort (repo override → app default),
  // applied to the launch. Claude-only flags — gate on the agent so a future
  // Codex/Cursor launch isn't handed `--model`/`--effort`/`--remote-control`.
  const isClaude = worktree.agent === "Claude";
  const workEffort = useResolvedSetting(repo, WORK_EFFORT_KEY).data;
  const settingsModel = useResolvedSetting(repo, WORK_MODEL_KEY).data;
  // The per-launch tray choice wins over the configured default; either applies
  // only on a fresh launch (a resume carries the session's own model).
  const model = launchModels[worktree.id] || settingsModel;
  const hookSettings = useClaudeHookSettings().data;
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY).value;
  const permissionMode = useResolvedSetting(repo, WORK_PERMISSION_MODE_KEY).data;
  // Seed the short "read the file" instruction rather than the prompt text: the
  // rendered work prompt can be huge, and typing it into the interactive-shell
  // seed overflows the line / gets mangled by the PTY line editor. The file is
  // written backend-side before the path resolves, so it exists by the time we
  // seed. Fall back to a one-line prompt only while the path is still loading.
  const seed = agentSessionSeed(session.data, exec, {
    prompt: workPrompt.data
      ? `Read ${workPrompt.data} and follow the instructions inside.`
      : `Work on ${worktree.id}: ${worktree.title}`,
    remoteControl: isClaude ? worktree.id : undefined,
    modelFlag: isClaude && model ? `--model ${shellQuote(model)}` : undefined,
    effortFlag: isClaude && workEffort ? `--effort ${shellQuote(workEffort)}` : undefined,
    settingsFlag: isClaude && hookSettings ? `--settings ${shellQuote(hookSettings)}` : undefined,
    chrome: isClaude && startWithChrome,
    permissionMode: isClaude ? (permissionMode ?? undefined) : undefined,
  });
  // Hold the terminal until the seed inputs are fresh (the new PTY only carries a
  // seed applied at creation). Crucially this must hold while the work prompt is
  // still fetching even though `needsSeed` is false then (it waits on
  // `promptReady`) — mounting in that window used to spawn a bare shell and
  // silently drop the agent launch.
  const preparing = shouldHoldTerminal({
    launching,
    initialSetup,
    promptFetched: workPrompt.isFetched,
    needsSeed,
    sessionFetching: session.isFetching,
  });

  return {
    isBase,
    launching,
    settingUp,
    initialSetup,
    refId,
    liveSession,
    liveSeen,
    setLiveSeen,
    ended,
    session,
    seed,
    preparing,
  };
}
