/**
 * The one place that decides how a launch carries santree's session hooks.
 *
 * The bug it exists to make unrepeatable: four of the five launch sites gated
 * the flag on `cliLaunchOptions` — a *Claude* capability — so a Codex
 * investigation, repo session, triage batch or AI review launched with no hooks
 * at all. Codex has no launch-time id flag, so a hookless launch never reports
 * the thread it minted: the session is unresumable and invisible to the
 * registry, while the terminal in front of you looks perfectly fine.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({
  settings: "/data/claude-hooks.json" as string | null,
  settingsFetched: true,
  noGitSettings: "/data/claude-hooks-no-git.json" as string | null,
  noGitFetched: true,
  codex: "-c 'hooks.SessionStart=[…]'" as string | null,
  codexFetched: true,
}));

vi.mock("../../lib/queries", () => ({
  useClaudeHookSettings: () => ({ data: q.settings, isFetched: q.settingsFetched }),
  useClaudeHookSettingsNoGit: () => ({ data: q.noGitSettings, isFetched: q.noGitFetched }),
  useCodexHookFlags: () => ({ data: q.codex, isFetched: q.codexFetched }),
}));

import { type HookInjectionOptions, useHookInjection } from "./useHookInjection";

const injection = (opts?: HookInjectionOptions) =>
  renderHook(() => useHookInjection(opts)).result.current;

beforeEach(() => {
  q.settings = "/data/claude-hooks.json";
  q.settingsFetched = true;
  q.noGitSettings = "/data/claude-hooks-no-git.json";
  q.noGitFetched = true;
  q.codex = "-c 'hooks.SessionStart=[…]'";
  q.codexFetched = true;
});

describe("useHookInjection", () => {
  it("hands each provider the mechanism it actually takes", () => {
    const { flagFor } = injection();

    expect(flagFor("Claude")).toBe("--settings '/data/claude-hooks.json'");
    expect(flagFor("Codex")).toBe("-c 'hooks.SessionStart=[…]'");
    // No hook mechanism at all — the launch carries nothing rather than a flag
    // its binary would reject.
    expect(flagFor("Cursor")).toBeUndefined();
    expect(flagFor("Opencode")).toBeUndefined();
  });

  it("takes the commit-denying variant for a no-git launch", () => {
    expect(injection({ noGit: true }).flagFor("Claude")).toBe(
      "--settings '/data/claude-hooks-no-git.json'",
    );
  });

  it("prefers an explicit settings file over the standard one", () => {
    expect(injection({ settingsPath: "/data/claude-hooks-ai-review.json" }).flagFor("Claude")).toBe(
      "--settings '/data/claude-hooks-ai-review.json'",
    );
  });

  it("has no flag to give when nothing resolved", () => {
    q.settings = null;
    q.codex = null;

    const { flagFor } = injection();
    expect(flagFor("Claude")).toBeUndefined();
    expect(flagFor("Codex")).toBeUndefined();
  });

  // Readiness is per provider on purpose: the flags resolve independently, and a
  // launch held on another provider's query is a launch that isn't happening.
  it("gates readiness on this provider's own flag, not on every provider's", () => {
    q.settingsFetched = false;

    const pending = injection();
    expect(pending.readyFor("Claude")).toBe(false);
    expect(pending.readyFor("Codex")).toBe(true);
    // Nothing to wait for when there's no mechanism.
    expect(pending.readyFor("Cursor")).toBe(true);

    q.settingsFetched = true;
    q.codexFetched = false;

    const other = injection();
    expect(other.readyFor("Claude")).toBe(true);
    expect(other.readyFor("Codex")).toBe(false);
  });

  it("waits on the variant the launch will actually use", () => {
    q.noGitFetched = false;

    expect(injection({ noGit: true }).readyFor("Claude")).toBe(false);
    expect(injection().readyFor("Claude")).toBe(true);
  });
});
