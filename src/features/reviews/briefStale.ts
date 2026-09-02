/**
 * Whether an AI review brief describes code the PR has moved past.
 *
 * One definition, because two surfaces answer this question and they must never
 * disagree: the brief itself renders a "new commits have landed" banner, and the
 * Trees panel's AI-work tab wears an amber dot. A dot that says stale over a
 * body that says current is worse than either signal alone.
 *
 * It lives in `reviews/` rather than beside either caller because the dependency
 * only runs one way — Trees hosts review components, not the reverse.
 *
 * The comparison is the backend's own: `review_drafts::publish` refuses a draft
 * whose stored `head_sha` isn't the PR's current one, so this is the same test,
 * not a second guess at it.
 */
import type { ReviewBrief } from "../../bindings";

/**
 * Whether something recorded at commit `at` has been overtaken by the PR's head.
 *
 * The brief is one such thing; the local checkout the panes read is another — a
 * detached review checkout sits at the head it was cut from, and the PR moves on
 * without it. Same comparison, so it is written once: either half being unknown
 * says nothing, and "unknown" must never read as "stale".
 */
function movedPast(at: string | null | undefined, headSha: string | null | undefined): boolean {
  return !!at && !!headSha && at !== headSha;
}

export function reviewBriefStale(
  brief: ReviewBrief | null | undefined,
  headSha: string | null | undefined,
): boolean {
  // A missing brief is not stale, it is absent — "outdated" has to mean the
  // review ran and has since been overtaken, or the signal cries wolf on every
  // PR nobody has reviewed yet.
  return !!brief && movedPast(brief.headSha, headSha);
}
