/**
 * The agent-session pipeline shared by every tab that runs an agent: the worktree's
 * main work terminal, an extra Claude tab, a Fix-CI tab, and the off-screen launcher.
 *
 * All of them need the same six things — latch whether a live PTY exists, decide
 * resume-vs-fresh-vs-shell, resolve exec/model/effort/settings/permission-mode,
 * build the one-shot seed, hold the terminal until every seed input has landed, and
 * drop the cached session resolution when the agent exits or is resumed. They used
 * to have three near-identical copies of it, which is why a missing hold gate had to
 * be fixed in three places.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import type { AgentKind, AgentSession } from "../../bindings";
import {
  CLAUDE_REMOTE_CONTROL_KEY,
  CLAUDE_START_WITH_CHROME_KEY,
  queryKeys,
  useAgentSession,
  useBoolSetting,
  useResolvedProviderSetting,
  useSetting,
  WORK_AGENT_KEY,
  WORK_EFFORT_KEY,
  WORK_MODEL_KEY,
  WORK_PERMISSION_MODE_KEY,
} from "../../lib/queries";
import { agentProvider, sessionAgent } from "../terminal/agentProvider";
import { agentSessionSeed, shellQuote } from "../terminal/agentSeed";
import { useTerminals } from "../terminal/TerminalsContext";
import { useHookInjection } from "../terminal/useHookInjection";

export interface AgentTabOptions {
  repo: string;
  /** The terminal registry key — this session's identity (`tree:<id>[:tab:<id>]`). */
  refId: string;
  /** Working directory: the worktree path. */
  cwd: string;
  /** Which agent binary to run. `null` (the base worktree) means a plain shell. */
  agent: AgentKind | null;
  /** Whether opening this tab may mint a *fresh* session, or only resume one. A
   *  Claude/Fix-CI tab exists to run the agent, so any open is an explicit launch;
   *  the main work terminal only launches when a task was actually started. */
  allowFresh: boolean;
  /** Hold the terminal back even once the session resolves — the caller has another
   *  input still in flight (the main terminal waits on its work-prompt file). */
  hold?: boolean;
  /** Don't resolve a session at all: this tab is a plain shell (the base worktree). */
  shellOnly?: boolean;
  /** The opening prompt, seeded on a fresh launch only. */
  prompt?: string;
  /** Name the session for Claude's Remote Control web (we pass the ticket id). */
  remoteControl?: string;
  /** Launch with the commit/push-denying settings file (the Fix-CI variant), so the
   *  agent fixes and validates but leaves committing to the user. */
  noGit?: boolean;
  /** Explicit restricted settings and MCP config for a source-scoped guided tab. */
  settingsPath?: string;
  mcpConfigPath?: string;
}

export interface AgentTab {
  /** A live PTY exists for this session right now. */
  live: boolean;
  /** The agent ran and has since exited — show the resume placeholder rather than a
   *  dead terminal. Latched, so quitting the agent doesn't instantly re-resume it
   *  into a restart loop. */
  ended: boolean;
  /** The terminal must not mount yet: a seed input is still resolving. The PTY only
   *  applies a seed at session creation, so mounting early spawns a bare shell and
   *  silently drops the launch. */
  preparing: boolean;
  session: ReturnType<typeof useAgentSession>;
  /** The command that (re)launches the agent, or undefined for a plain shell. */
  seed: string | undefined;
  /** Explicitly (re)start the agent after it exited. */
  resume: () => void;
  /** Hand to `WorktreeTerminal.onExited`. */
  onExited: () => void;
}

export function useAgentTab(opts: AgentTabOptions): AgentTab {
  const { repo, refId, cwd, agent, allowFresh, hold, shellOnly, noGit } = opts;
  const qc = useQueryClient();

  // Whether a live PTY already exists for this session. We only resolve a (re)launch
  // when there's none to attach to — and `liveSeen` latches, so quitting the agent
  // (the session dies under us) doesn't immediately re-resume it into a loop.
  const { tabs } = useTerminals();
  const live = tabs.some((t) => t.source === "issue" && t.refId === refId);
  const [liveSeen, setLiveSeen] = useState(false);
  useEffect(() => {
    if (live) setLiveSeen(true);
  }, [live]);
  const ended = !shellOnly && liveSeen && !live;

  const needsSeed = !shellOnly && !hold && !live && !liveSeen;
  const session = useAgentSession(repo, refId, cwd, allowFresh, agent ?? "Claude", needsSeed);

  const requestedAgent = agent ?? "Claude";
  const resolvedAgent = sessionAgent(session.data, requestedAgent);
  const provider = agentProvider(resolvedAgent);
  const model = useResolvedProviderSetting(repo, WORK_MODEL_KEY, requestedAgent, WORK_AGENT_KEY);
  const effort = useResolvedProviderSetting(repo, WORK_EFFORT_KEY, requestedAgent, WORK_AGENT_KEY);
  const permissionMode = useResolvedProviderSetting(
    repo,
    WORK_PERMISSION_MODE_KEY,
    requestedAgent,
    WORK_AGENT_KEY,
  );
  // Whatever this provider's hooks ride in on — a `--settings` file, `-c` config
  // overrides — lands in `settingsFlag`, because to the seed builder they are the
  // same thing: the flag that makes this launch report its session back.
  const hooks = useHookInjection({ noGit, settingsPath: opts.settingsPath });
  const startWithChrome = useBoolSetting("app", CLAUDE_START_WITH_CHROME_KEY);
  const remoteControl = useSetting("app", CLAUDE_REMOTE_CONTROL_KEY);

  // The model is never a launch-time choice: a fresh launch always runs the model
  // configured for this agent in Settings → Actions → Work (a resume carries the
  // session's own).
  //
  // Everything below is Claude's launch line. Codex's — sandbox, approval policy,
  // model, effort, and a review's MCP tool server — is resolved backend-side from
  // the same settings and rides on `session.data.launchFlags`, so it cannot be
  // dropped by a call site that forgot to pass it. See `codex_config.rs`.
  const seed = agentSessionSeed(session.data, {
    repo,
    termKey: refId,
    prompt: opts.prompt,
    remoteControl:
      provider.capabilities.remoteControl && remoteControl.data !== "false"
        ? opts.remoteControl
        : undefined,
    modelFlag:
      provider.capabilities.cliLaunchOptions && model.data
        ? `--model ${shellQuote(model.data)}`
        : undefined,
    effortFlag:
      provider.capabilities.cliLaunchOptions && effort.data
        ? `--effort ${shellQuote(effort.data)}`
        : undefined,
    settingsFlag: hooks.flagFor(resolvedAgent),
    mcpFlag:
      provider.capabilities.cliLaunchOptions && opts.mcpConfigPath
        ? `--mcp-config ${shellQuote(opts.mcpConfigPath)}`
        : undefined,
    chrome: provider.capabilities.cliLaunchOptions && startWithChrome.value,
    permissionMode: provider.capabilities.permissionMode
      ? (permissionMode.data ?? undefined)
      : undefined,
  });

  // Every launch flag must have *resolved* before the PTY spawns — not just the
  // session. `agentSessionSeed` builds the command once and the PTY applies it at
  // creation, so a flag that arrives late is silently dropped: a Fix-CI tab that
  // launches before `--settings` resolves runs without the commit/push-denying
  // guardrail it exists to enforce. Gate on each query's `isFetched`, never on its
  // value: a boolean setting reads `false` both when it's off and when it hasn't
  // loaded, so `startWithChrome !== undefined` was true from the first render and
  // gated nothing — a launch in that window quietly dropped `--chrome`.
  // A Codex launch that beats its hook flags reports no session id at all — the
  // session is then unresumable and never reaches the registry — so the gate
  // covers that provider even though it takes none of the Claude-only flags.
  // Its sandbox, approval policy and review tools need no gate of their own:
  // they arrive *with* the session, and `session.isFetching` already holds the
  // terminal until it does.
  const flagsReady =
    hooks.readyFor(resolvedAgent) &&
    (!provider.capabilities.cliLaunchOptions ||
      (model.isFetched &&
        effort.isFetched &&
        permissionMode.isFetched &&
        startWithChrome.isFetched &&
        remoteControl.isFetched));
  const preparing =
    !shellOnly && (hold === true || (needsSeed && (session.isFetching || !flagsReady)));

  // Drop the cached session resolution: it may predate this exit (the process can
  // die while the pane is unmounted, so `onExited` never fired) and would replay a
  // stale decision — a `--session-id` for a session whose transcript now exists, or
  // a "fresh" verdict that `session::resolve` would now correctly resume.
  const dropSession = useCallback(() => {
    qc.removeQueries({ queryKey: queryKeys.agentSessionPrefix(repo, refId, requestedAgent) });
  }, [qc, repo, refId, requestedAgent]);

  const resume = useCallback(() => {
    dropSession();
    setLiveSeen(false);
  }, [dropSession]);

  return { live, ended, preparing, session, seed, resume, onExited: dropSession };
}

/** The resolved session's id, or null for a plain shell / an unresolved session —
 *  what the inline usage bar keys on. */
export function sessionIdOf(session: AgentSession | undefined): string | null {
  return session && session.type !== "shell" ? session.sessionId : null;
}
