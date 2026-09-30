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
  repos: [
    { name: "acme/app", location: "Local" },
    { name: "acme/web", location: "Daedalus" },
  ] as { name: string; location: string }[] | undefined,
  box: {
    claudeSettings: "/srv/web/.git/santree/claude-hooks.json",
    claudeSettingsNoGit: "/srv/web/.git/santree/claude-hooks-fixci.json",
    codexFlags: "-c 'hooks.SessionStart=[box]'",
  } as { claudeSettings: string; claudeSettingsNoGit: string; codexFlags: string } | undefined,
  boxFetched: true,
  boxAsked: [] as [string, boolean][],
}));

vi.mock("../../lib/queries", () => ({
  useClaudeHookSettings: () => ({ data: q.settings, isFetched: q.settingsFetched }),
  useClaudeHookSettingsNoGit: () => ({ data: q.noGitSettings, isFetched: q.noGitFetched }),
  useCodexHookFlags: () => ({ data: q.codex, isFetched: q.codexFetched }),
  useRepos: () => ({ data: q.repos }),
  useDaedalusAgentHooks: (repo: string, enabled: boolean) => {
    q.boxAsked.push([repo, enabled]);
    const fetched = enabled && q.boxFetched;
    return { data: fetched ? q.box : undefined, isFetched: fetched };
  },
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
  q.repos = [
    { name: "acme/app", location: "Local" },
    { name: "acme/web", location: "Daedalus" },
  ];
  q.boxFetched = true;
  q.boxAsked = [];
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

  it("hands a Daedalus project's launch the hooks written on the box", () => {
    const remote = injection({ repo: "acme/web" });
    expect(remote.flagFor("Claude")).toBe("--settings '/srv/web/.git/santree/claude-hooks.json'");
    expect(remote.flagFor("Codex")).toBe("-c 'hooks.SessionStart=[box]'");
    expect(injection({ repo: "acme/web", noGit: true }).flagFor("Claude")).toBe(
      "--settings '/srv/web/.git/santree/claude-hooks-fixci.json'",
    );
    // A project on this Mac never asks the box.
    expect(injection({ repo: "acme/app" }).flagFor("Claude")).toBe(
      "--settings '/data/claude-hooks.json'",
    );
    expect(q.boxAsked).toContainEqual(["acme/app", false]);
  });

  it("holds a launch until it knows where the project lives and the box has its hooks", () => {
    q.boxFetched = false;
    expect(injection({ repo: "acme/web" }).readyFor("Claude")).toBe(false);
    expect(injection({ repo: "acme/web" }).readyFor("Codex")).toBe(false);
    // Never this Mac's paths in the meantime.
    expect(injection({ repo: "acme/web" }).flagFor("Claude")).toBeUndefined();

    q.boxFetched = true;
    q.repos = undefined;
    expect(injection({ repo: "acme/web" }).readyFor("Claude")).toBe(false);
  });

  it("waits on the variant the launch will actually use", () => {
    q.noGitFetched = false;

    expect(injection({ noGit: true }).readyFor("Claude")).toBe(false);
    expect(injection().readyFor("Claude")).toBe(true);
  });
});
