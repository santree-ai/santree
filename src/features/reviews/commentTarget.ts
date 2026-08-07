/**
 * Where a review comment is being written — the identity every write path needs,
 * derived once from the selected PR plus its fetched detail.
 *
 * Kept apart from the components because two of these fields are load-bearing and
 * easy to get subtly wrong: `headSha` must be the commit the *diff on screen* was
 * built from (GitHub rejects a comment whose commit doesn't match the line
 * numbers), and `pendingReviewId` decides whether a draft comment opens a new
 * review or joins the one already in progress.
 */
import { SplitSide } from "@git-diff-view/react";

export interface CommentTarget {
  /** "owner/name" — the PR's own repo, which need not be the active one. */
  prRepo: string;
  number: number;
  /** The PR's GraphQL node id — what a new pending review is opened against. */
  prId: string;
  /**
   * Head commit the comment anchors to. Comes from the fetched `PrDetail`, never
   * from the inbox row: the detail's head is what the diff on screen was built
   * from, while the list row's can be a poll ahead of it — and a comment whose
   * commit doesn't match the line numbers is exactly what GitHub rejects.
   *
   * Empty until the detail loads, which is when the `+` button stays hidden.
   */
  headSha: string;
  /** The viewer's in-progress review, when they have one. */
  pendingReviewId: string | null;
}

/**
 * Which file a diff row's line number belongs to, in the terms GitHub's review
 * API uses: the new (right) file, or the old (left) one. The diff viewer numbers
 * each side independently, so this is what keeps a comment on a deleted line from
 * landing on an unrelated added line with the same number.
 */
export function isRightSide(side: SplitSide): boolean {
  return side !== SplitSide.old;
}
