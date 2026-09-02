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
import type { PrCheckout } from "./PrCheckout";

const spies = vi.hoisted(() => ({
  requestFixCiLaunch: vi.fn(),
  abandonLaunchTab: vi.fn(),
  addPendingLaunches: vi.fn(),
  removePendingLaunch: vi.fn(),
  navigate: vi.fn(),
  createWorktree: vi.fn(),
  promote: vi.fn(),
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
  usePromoteReviewWorktree: () => ({ mutateAsync: spies.promote }),
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
// The worktree dialog, recorded rather than rendered: what matters here is that
// the flow asks, names the action, and honours the answer.
let asked: string[] = [];
let gateAnswer = { ok: true, runSetup: false };
vi.mock("./WorktreeGate", () => ({
  useWorktreeGate: () => (action: string) => {
    asked.push(action);
    return Promise.resolve(gateAnswer);
  },
}));

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
  asked = [];
  gateAnswer = { ok: true, runSetup: false };
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

/** A PR with nothing on disk. Starting work has to cut the checkout, which is
 *  the thing the dialog exists to ask about. */
const NO_CHECKOUT = {
  repo: "acme/app",
  worktree: null,
  worktreeId: "",
  source: { worktree: null, worktreeId: "", repo: "acme/app", isReview: false },
  openAsTree: vi.fn(),
  opening: false,
  canOpen: true,
} as unknown as PrCheckout;

/** The same PR, already checked out *for review* — a worktree Trees doesn't list.
 *  Nothing new reaches the disk, so there is nothing to confirm; what has to
 *  happen is the label coming off, or this would navigate to a tree the
 *  destination can't show. */
const REVIEW_CHECKOUT = {
  ...NO_CHECKOUT,
  worktreeId: "review-4-acme-3-app-42",
  source: {
    worktree: { id: "review-4-acme-3-app-42" },
    worktreeId: "review-4-acme-3-app-42",
    repo: "acme/app",
    isReview: true,
  },
} as unknown as PrCheckout;

/** A PR that is already checked out: the flow then has nothing to put on disk,
 *  so it neither asks nor promotes — which is what these cases exercise. The
 *  gated path (no checkout at all) has its own case at the end. */
const CHECKED_OUT = {
  repo: "acme/app",
  worktree: { id: "wt-9" },
  worktreeId: "wt-9",
  source: { worktree: { id: "wt-9" }, worktreeId: "wt-9", repo: "acme/app", isReview: false },
  openAsTree: vi.fn(),
  opening: false,
  canOpen: true,
} as unknown as PrCheckout;

describe("useStartWorkFromReviews", () => {
  it("opens the tab as soon as the worktree lands, not when the prompt does", async () => {
    const command = pending<AiReviewLaunch>();
    spies.createWorktree.mockResolvedValue({ id: "wt-9" });
    spies.reviewFixLaunch.mockReturnValue(command.promise);

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", CHECKED_OUT));
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

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", CHECKED_OUT));
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

    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", CHECKED_OUT));
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

  /** Reported: "Start work" on the queue went straight to cutting a worktree.
   *  Every other surface that puts one on disk asks first, and this one is the
   *  least expected of them — you are reading a pull request, not starting a
   *  task in a repo you chose. */
  it("asks before it cuts a checkout, and does nothing if declined", async () => {
    gateAnswer = { ok: false, runSetup: false };
    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", NO_CHECKOUT));
    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(asked).toEqual(["Starting work on this pull request"]);
    expect(spies.createWorktree).not.toHaveBeenCalled();
    expect(spies.addPendingLaunches).not.toHaveBeenCalled();
    expect(spies.navigate).not.toHaveBeenCalled();
    // …and the button comes back, or the surface is dead after a cancel.
    await waitFor(() => expect(result.current.starting).toBe(false));
  });

  it("goes ahead once the worktree is confirmed", async () => {
    spies.createWorktree.mockResolvedValue({ id: "wt-9" });
    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", NO_CHECKOUT));
    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spies.createWorktree).toHaveBeenCalled();
    expect(spies.navigate).toHaveBeenCalled();
  });

  /** It navigates to Trees, and Trees does not list a checkout still labelled a
   *  review — so the label has to come off on the way, or this lands on a
   *  worktree the destination cannot show. */
  it("keeps a review checkout instead of asking about one that exists", async () => {
    spies.createWorktree.mockResolvedValue({ id: "review-4-acme-3-app-42" });
    const { result } = renderHook(() => useStartWorkFromReviews(PR, "acme/app", REVIEW_CHECKOUT));
    act(() => result.current.start());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(asked).toEqual([]);
    expect(spies.promote).toHaveBeenCalledWith({ prRepo: PR.repo, number: PR.number });
  });
});
