/**
 * Which local checkout the Reviews rail's branch panes are reading, and whether
 * the pull request has moved past it.
 *
 * A pull request has **one** checkout now — an ordinary worktree on its branch,
 * cut by whichever action needed it first (an AI review, a terminal, "open as
 * tree"). It used to have two: that worktree, and a detached throwaway under
 * `.santree/reviews/` that the AI review read from and santree deleted on a
 * schedule. Those are one thing, so the panes no longer have to say which they
 * are showing.
 *
 * What is left to say is whether it is still *labelled* a review. A review
 * checkout is kept out of Trees, so it is somewhere you are reading rather than
 * somewhere you are working — one click from being either.
 *
 * Two sources still reach here, because a PR's branch can also be checked out
 * under a ticket's own worktree (AK-276, say) that the user started before the
 * PR existed. That one wins: it is already work, and it is already in Trees.
 */
import type { ReviewCheckout, ReviewPr, Worktree } from "../../bindings";

/** Collision-free, path-safe id for a PR's checkout — **the same string the
 *  backend's `review_worktree_id` mints**, so a pull request's worktree has one
 *  name on both sides of the bridge. GitHub owner/repo components are already
 *  validated there; the lengths distinguish ambiguous joined slugs (`a-b/c` from
 *  `a/b-c`).
 *
 *  It lives here rather than on the header that used to own it: the header now
 *  reads the checkout through `usePrCheckout`, and an id minter that imported
 *  half the PR chrome to be reached was a cycle waiting to close. */
export function reviewTreeId(pr: Pick<ReviewPr, "repo" | "number">): string {
  const [owner, name] = pr.repo.split("/");
  return `review-${owner.length}-${owner}-${name.length}-${name}-${pr.number}`;
}

/** The one sentence that says what reviewing with AI puts on disk. Stated
 *  wherever the action is offered — the "+" menu, the brief's start button, the
 *  review pane — and again above the panes that read it, so the checkout is never
 *  something you discover afterwards in a directory listing. */
export const REVIEW_CHECKOUT_NOTE =
  "Reviewing with AI checks the PR out as a worktree on its branch. It works like any other checkout — terminals, agents, the setup script — but stays out of Trees until you keep it.";

/**
 * What the button is called, and what it says it does — one name per state of the
 * disk, so it can't promise the wrong thing.
 *
 * With nothing checked out, "Open as tree" is the whole story: it cuts the
 * worktree. With the review's checkout already there, cutting one would be a lie
 * — it exists, the panes are listing its files. What the button actually does
 * then is *keep* it: drop the review label so it appears in Trees as work you
 * started. Same checkout, same branch, no second directory.
 */
export function openTreeAction(hasReviewCheckout: boolean): { label: string; title: string } {
  return hasReviewCheckout
    ? {
        label: "Keep as a worktree",
        title:
          "This pull request is already checked out for review. Keeping it lists it in Trees as your own work — same checkout, same branch.",
      }
    : { label: "Open as tree", title: "Check this PR out as a worktree on its branch" };
}

/** What the branch panes read, once the preference above has been applied. */
export interface CheckoutSource {
  /** The checkout itself, or `null` when the PR has neither kind yet. */
  worktree: Worktree | null;
  /** Its id — `""` when there is none, which is what leaves every
   *  worktree-scoped read disabled rather than fetched against a guess. */
  worktreeId: string;
  /** The project the reads are keyed by. The review checkout names its own (it
   *  can live under a clone other than the one the PR is attributed to). */
  repo: string;
  /** True when the checkout is still labelled a review — an ordinary worktree in
   *  every respect except that Trees doesn't list it. */
  isReview: boolean;
}

/**
 * A ticket's own worktree on this branch when there is one, else the PR's
 * checkout.
 *
 * The preference is not a tie-break: a tree the user started is already theirs
 * and already in Trees, so pointing the panes at it keeps one place to work in
 * rather than two views of one branch.
 */
export function checkoutSource(
  repo: string,
  worktree: Worktree | null,
  review: ReviewCheckout | null | undefined,
): CheckoutSource {
  if (worktree) return { worktree, worktreeId: worktree.id, repo, isReview: false };
  if (review)
    return {
      worktree: review.worktree,
      worktreeId: review.worktree.id,
      repo: review.repo,
      isReview: true,
    };
  return { worktree: null, worktreeId: "", repo, isReview: false };
}

/**
 * Whether the checkout is behind the branch it is on — the one thing there is to
 * do about it, so a boolean rather than a mode.
 *
 * It used to be a two-member union. `"recheckout"` moved the detached review tree
 * wholesale to the PR's head, because a tree on no branch has no tracking ref to
 * be behind; every checkout is a worktree on a branch now, so "is it behind?" is
 * git's own question and the answer is an ordinary pull.
 *
 * Deliberately not a HEAD comparison against the PR: a checkout can be
 * legitimately *ahead* (local commits), and comparing heads would offer to
 * "update" a branch that is simply further along.
 */
export function needsPull(source: CheckoutSource): boolean {
  return !!source.worktree && source.worktree.remoteBehind > 0;
}
