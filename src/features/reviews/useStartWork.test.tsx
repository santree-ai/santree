/**
 * What a click on "Start work" / "Start review" is allowed to feel like.
 *
 * The launch command behind these takes seconds — it fetches the PR, writes the
 * diff index, renders the prompt and lays down the settings and MCP files — and
 * for as long as the tab was only opened *after* all of that, a click produced
 * nothing at all: no tab, no busy button, and then an agent already talking. So
 * these cover the three things that were missing, at the source rather than in
 * each of the four buttons: the tab is requested before the command resolves, the
 * launcher reports itself running while it is, and a failure clears both.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiReviewLaunch, ReviewPr } from "../../bindings";
import type { FixCiLaunch } from "../../state/AppContext";

const spies = vi.hoisted(() => ({
  requestFixCiLaunch: vi.fn(),
  abandonLaunchTab: vi.fn(),
  addPendingLaunches: vi.fn(),
  removePendingLaunch: vi.fn(),
  navigate: vi.fn(),
  createWorktree: vi.fn(),
  reviewFixLaunch: vi.fn(),
  aiReviewLaunch: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => spies.navigate }));

vi.mock("../../bindings", () => ({
  commands: {
    reviewFixLaunch: (...args: unknown[]) => spies.reviewFixLaunch(...args),
    aiReviewLaunch: (...args: unknown[]) => spies.aiReviewLaunch(...args),
  },
}));

vi.mock("../../lib/queries", () => ({
  REVIEW_AGENT_KEY: "review_agent",
  // The real one unwraps a Result and throws its error; the commands here are
  // mocked at the promise, so the identity is the whole contract that matters.
  unwrap: <T,>(p: Promise<T>) => p,
  useResolvedSetting: () => ({ data: "Codex" }),
  useCreateWorktree: () => ({ mutateAsync: spies.createWorktree }),
}));

vi.mock("../../state/AppContext", () => ({
  useAppUi: () => ({
    requestFixCiLaunch: spies.requestFixCiLaunch,
    abandonLaunchTab: spies.abandonLaunchTab,
    addPendingLaunches: spies.addPendingLaunches,
    removePendingLaunch: spies.removePendingLaunch,
  }),
}));

vi.mock("../../state/toast", () => ({ toast: { error: spies.error, success: vi.fn() } }));

// Only the target mapping is needed here; the module also carries components.
vi.mock("./ReviewSessionShared", () => ({
  reviewTargetFor: (pr: ReviewPr) => ({ prRepo: pr.repo, number: pr.number }),
}));

import {
  useStartAiReviewInWorktree,
  useStartWorkFromReviews,
  useStartWorkInWorktree,
} from "./useStartWork";

const PR = {
  id: "pr-7",
  repo: "acme/app",
  number: 7,
  title: "Speed up the launch",
  headRef: "santree/AK-1",
} as ReviewPr;

const LAUNCH: AiReviewLaunch = {
  promptPath: "/tmp/prompt.md",
  settingsPath: "/tmp/settings.json",
  mcpConfigPath: "/tmp/mcp.json",
};

/** A command that hasn't answered yet — the several seconds this is all about. */
function pending<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

/** The hand-off requests made so far, in order. */
function handoffs(): FixCiLaunch[] {
  return spies.requestFixCiLaunch.mock.calls.map(([launch]) => launch as FixCiLaunch);
}

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
});

describe("useStartWorkInWorktree", () => {
  it("opens the tab before the launch command has answered", async () => {
    const command = pending<AiReviewLaunch>();
    spies.reviewFixLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartWorkInWorktree(PR, "wt-1", "acme/app"));
    act(() => result.current.start());

    // Synchronously, in the click itself: the whole tab identity minus the paths
    // that don't exist yet. Trees can open and focus it on this alone.
    const [opened] = handoffs();
    expect(opened).toMatchObject({
      phase: "preparing",
      worktreeId: "wt-1",
      kind: "fixCi",
      title: "Address review",
      agentKind: "Codex",
      pr: { repo: "acme/app", number: 7 },
    });
    expect(opened.promptPath).toBeUndefined();
    expect(opened.mcpConfigPath).toBeUndefined();
    expect(result.current.starting).toBe(true);

    await act(async () => {
      command.settle(LAUNCH);
      await command.promise;
    });

    // Same tab, now with the paths — the row's kind/pr/agent must not drift, or a
    // restart re-derives the wrong launch from the persisted row.
    const [, ready] = handoffs();
    expect(ready).toMatchObject({
      phase: "ready",
      tabId: opened.tabId,
      worktreeId: "wt-1",
      kind: "fixCi",
      agentKind: "Codex",
      pr: { repo: "acme/app", number: 7 },
      ...LAUNCH,
    });
    await waitFor(() => expect(result.current.starting).toBe(false));
  });

  it("takes the speculative tab back down when the launch fails", async () => {
    const command = pending<AiReviewLaunch>();
    spies.reviewFixLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartWorkInWorktree(PR, "wt-1", "acme/app"));
    act(() => result.current.start());
    const [opened] = handoffs();

    await act(async () => {
      command.fail(new Error("gh: rate limited"));
      await command.promise.catch(() => {});
    });

    expect(spies.abandonLaunchTab).toHaveBeenCalledWith(opened.tabId);
    expect(spies.error).toHaveBeenCalledWith("gh: rate limited");
    // Idle again, so the user can retry from the same button.
    await waitFor(() => expect(result.current.starting).toBe(false));
  });

  it("ignores a second click while the first launch is still running", () => {
    spies.reviewFixLaunch.mockReturnValue(pending<AiReviewLaunch>().promise);

    const { result } = renderHook(() => useStartWorkInWorktree(PR, "wt-1", "acme/app"));
    act(() => result.current.start());
    act(() => result.current.start());

    // One worktree, one tab, one agent: the guard still blocks within the click.
    expect(spies.reviewFixLaunch).toHaveBeenCalledTimes(1);
    expect(handoffs()).toHaveLength(1);
  });
});

describe("useStartAiReviewInWorktree", () => {
  it("opens its own tab kind before the command answers", async () => {
    const command = pending<AiReviewLaunch>();
    spies.aiReviewLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartAiReviewInWorktree(PR, "wt-1", "acme/app"));
    act(() => result.current.start());

    expect(handoffs()[0]).toMatchObject({
      phase: "preparing",
      kind: "aiReview",
      title: "AI review",
      agentKind: "Codex",
    });
    expect(result.current.starting).toBe(true);

    await act(async () => {
      command.settle(LAUNCH);
      await command.promise;
    });
    expect(handoffs()[1]).toMatchObject({ phase: "ready", kind: "aiReview", ...LAUNCH });
  });

  it("honours a per-launch agent override without touching the setting", () => {
    spies.aiReviewLaunch.mockReturnValue(pending<AiReviewLaunch>().promise);

    const { result } = renderHook(() => useStartAiReviewInWorktree(PR, "wt-1", "acme/app"));
    act(() => result.current.start("Claude"));

    expect(handoffs()[0]).toMatchObject({ agentKind: "Claude" });
  });
});

describe("useStartWorkFromReviews", () => {
  it("opens the tab as soon as the worktree lands, not when the prompt does", async () => {
    const command = pending<AiReviewLaunch>();
    spies.createWorktree.mockResolvedValue({ id: "wt-9" });
    spies.reviewFixLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app"));
    act(() => result.current.start());

    // Nothing to hang a tab on yet — the sidebar's pending row covers this bit.
    expect(spies.addPendingLaunches).toHaveBeenCalled();
    expect(handoffs()).toHaveLength(0);
    expect(result.current.starting).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The worktree exists, the prompt does not: the tab goes up anyway.
    expect(handoffs()[0]).toMatchObject({ phase: "preparing", worktreeId: "wt-9" });

    await act(async () => {
      command.settle(LAUNCH);
      await command.promise;
    });
    expect(handoffs()[1]).toMatchObject({ phase: "ready", worktreeId: "wt-9", ...LAUNCH });
    await waitFor(() => expect(result.current.starting).toBe(false));
  });

  it("clears the placeholder, the tab and the button when the render fails", async () => {
    const command = pending<AiReviewLaunch>();
    spies.createWorktree.mockResolvedValue({ id: "wt-9" });
    spies.reviewFixLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app"));
    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const [opened] = handoffs();

    await act(async () => {
      command.fail(new Error("no PR"));
      await command.promise.catch(() => {});
    });

    expect(spies.abandonLaunchTab).toHaveBeenCalledWith(opened.tabId);
    expect(spies.removePendingLaunch).toHaveBeenCalled();
    await waitFor(() => expect(result.current.starting).toBe(false));
  });

  it("leaves no tab to clean up when the worktree itself fails", async () => {
    spies.createWorktree.mockRejectedValue(new Error("worktree exists"));

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app"));
    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(handoffs()).toHaveLength(0);
    expect(spies.abandonLaunchTab).not.toHaveBeenCalled();
    expect(spies.removePendingLaunch).toHaveBeenCalled();
    await waitFor(() => expect(result.current.starting).toBe(false));
  });
});
