/**
 * How a launch gets santree's session hooks in — the one place that decides.
 *
 * Every agent launch has to carry them. The hooks are what report the session id
 * back to santree, and that is what makes a session resumable, attributable to
 * the surface that started it, and visible in the registry at all: a launch that
 * misses them runs a real agent that nothing in the app can see, resume, or
 * count.
 *
 * The mechanism is per provider, so it can never be a constant — Claude takes a
 * `--settings <file>`, Codex takes `-c 'hooks.<Event>=[…]'` config overrides, and
 * a provider with neither takes nothing. That branch used to live at exactly one
 * of the five launch sites; the other four gated it on `cliLaunchOptions`, which
 * is a *Claude* capability (`false` for Codex), so every Codex investigation,
 * repo session, triage batch and AI review launched hookless. Hence one hook: a
 * new launch site can forget to think about providers, but it can't forget this.
 */
import { useCallback } from "react";

import type { AgentKind } from "../../bindings";
import {
  useClaudeHookSettings,
  useClaudeHookSettingsNoGit,
  useCodexHookFlags,
} from "../../lib/queries";
import { agentProvider, shellQuote } from "./agentProvider";

export interface HookInjectionOptions {
  /** Launch Claude with the commit/push-denying settings variant — the Fix-CI
   *  tab, which fixes and validates but leaves committing to the user. */
  noGit?: boolean;
  /** An explicit Claude settings file (the AI review's restricted deny/allow
   *  variant), used instead of the standard one. A caller that passes this must
   *  hold its launch until the path resolves: falling through to the standard
   *  settings would run the review with no deny list at all. */
  settingsPath?: string | null;
}

export interface HookInjection {
  /**
   * The launch flag(s) that make a session report itself back, or `undefined`
   * when the provider has no hook mechanism (Cursor, OpenCode) or nothing
   * resolved.
   *
   * A function of the kind rather than a value, because the provider isn't
   * always known at render: a resolved session carries its own `agentKind`
   * (a persisted Codex investigation reopened from a Claude-configured surface),
   * and the batch launcher only learns it inside its callback. Pass the
   * **resolved** kind — the one whose binary is about to run.
   */
  flagFor: (kind: AgentKind) => string | undefined;
  /**
   * This provider's hook flag has resolved. Gate the launch on it:
   * `agentSessionSeed` builds the command once and the PTY applies it at session
   * creation, so a flag that arrives late is silently dropped — and a hookless
   * launch is exactly the invisible session this hook exists to prevent.
   *
   * Per provider, not global: a Codex tab must not be held waiting on Claude's
   * settings file, and vice versa.
   */
  readyFor: (kind: AgentKind) => boolean;
}

export function useHookInjection(opts: HookInjectionOptions = {}): HookInjection {
  const { noGit = false, settingsPath } = opts;
  // All three are observed unconditionally: hooks can't be conditional, and each
  // is a `staleTime: Infinity` read of a resolved local path (shared app-wide, so
  // at most one fetch per app run).
  const claude = useClaudeHookSettings();
  const claudeNoGit = useClaudeHookSettingsNoGit();
  const codex = useCodexHookFlags();

  const settings = settingsPath ?? (noGit ? claudeNoGit.data : claude.data);
  const settingsFetched = noGit ? claudeNoGit.isFetched : claude.isFetched;
  const codexFlags = codex.data;
  const codexFetched = codex.isFetched;

  const flagFor = useCallback(
    (kind: AgentKind) => {
      switch (agentProvider(kind).capabilities.hookInjection) {
        case "settings-file":
          return settings ? `--settings ${shellQuote(settings)}` : undefined;
        case "config-flags":
          return codexFlags ?? undefined;
        default:
          return undefined;
      }
    },
    [settings, codexFlags],
  );

  const readyFor = useCallback(
    (kind: AgentKind) => {
      switch (agentProvider(kind).capabilities.hookInjection) {
        case "settings-file":
          return settingsFetched;
        case "config-flags":
          return codexFetched;
        default:
          return true;
      }
    },
    [settingsFetched, codexFetched],
  );

  return { flagFor, readyFor };
}
