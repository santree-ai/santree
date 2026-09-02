import { describe, expect, it } from "vitest";

import type { ReviewCheckout } from "../../bindings";
import { worktree as fxWorktree } from "../../test/fixtures";
import { checkoutSource, needsPull, openTreeAction } from "./checkoutSource";

/** What the backend hands back for a PR that has been checked out: an ordinary
 *  worktree on the PR's branch, under the project that actually holds it. It is
 *  told apart from any other worktree by one thing — a `review_worktrees` row —
 *  which is why nothing here is detached or commit-shaped any more. */
const review = (over: Parameters<typeof fxWorktree>[1] = {}): ReviewCheckout => ({
  repo: "acme/web",
  worktree: fxWorktree("review-4-acme-3-web-7", { branch: "user/pr-branch", ...over }),
});

describe("checkoutSource", () => {
  it("prefers a ticket's own worktree over the PR's checkout", () => {
    const mine = fxWorktree("AK-1", { branch: "feature" });
    const source = checkoutSource("acme/web", mine, review());
    expect(source.worktree).toBe(mine);
    expect(source.worktreeId).toBe("AK-1");
    expect(source.isReview).toBe(false);
  });

  it("falls back to the PR's checkout, naming the project that holds it", () => {
    // Deliberately a different repo argument: the checkout can live under a clone
    // other than the one the PR is attributed to, and the panes read through the
    // one that actually has it.
    const source = checkoutSource("acme/other-clone", null, review());
    expect(source.worktreeId).toBe("review-4-acme-3-web-7");
    expect(source.repo).toBe("acme/web");
    // Still labelled a review, which is the only thing that keeps it out of Trees.
    expect(source.isReview).toBe(true);
  });

  it("reports nothing to read when the PR has neither", () => {
    const source = checkoutSource("acme/web", null, null);
    expect(source.worktree).toBeNull();
    // The empty id is what leaves every worktree-scoped read disabled.
    expect(source.worktreeId).toBe("");
    expect(source.isReview).toBe(false);
  });
});

describe("needsPull", () => {
  it("offers a pull only while the checkout's remote is ahead", () => {
    const current = fxWorktree("AK-1", { branch: "feature" });
    expect(needsPull(checkoutSource("r", current, null))).toBe(false);
    const behind = fxWorktree("AK-1", { branch: "feature", remoteBehind: 3 });
    expect(needsPull(checkoutSource("r", behind, null))).toBe(true);
  });

  /** The review checkout is a branch checkout like any other now, so it gets the
   *  same answer — not the wholesale "move it to the PR's head" the detached tree
   *  needed, which is gone along with the detached tree. */
  it("answers the same way for the PR's own checkout", () => {
    expect(needsPull(checkoutSource("r", null, review()))).toBe(false);
    expect(needsPull(checkoutSource("r", null, review({ remoteBehind: 2 })))).toBe(true);
  });

  it("never reads a checkout's own commits as something to update", () => {
    // A worktree on the branch can legitimately be *ahead* — comparing heads
    // would offer to "update" a checkout that is simply further along.
    const ahead = fxWorktree("AK-1", { branch: "feature", ahead: 2, unpushed: 2 });
    expect(needsPull(checkoutSource("r", ahead, null))).toBe(false);
  });

  it("has nothing to offer for a PR with no checkout at all", () => {
    expect(needsPull(checkoutSource("r", null, null))).toBe(false);
  });
});

describe("openTreeAction", () => {
  /** One checkout per PR: with nothing on disk the button cuts one, and with the
   *  review's checkout there it can only *keep* it. Offering to "add a worktree"
   *  in the second case would promise a second directory that never appears. */
  it("cuts a checkout when there is none and keeps the one there is", () => {
    expect(openTreeAction(false).label).toBe("Open as tree");
    expect(openTreeAction(true).label).toBe("Keep as a worktree");
    expect(openTreeAction(true).title).toContain("same checkout");
  });
});
