/**
 * Who wrote a PR comment, as the conversation filter groups them.
 *
 * A busy PR's conversation is mostly machines — CI summaries, migration dumps,
 * coverage reports — and the one human question in the middle of it is the thing
 * you opened the PR to find. So the filter exists to get the people back.
 *
 * The Humans/Bots split comes from `PrComment.isBot`, which the backend reads off
 * GitHub's own `Actor.__typename`. Deliberately *not* a login-name heuristic here:
 * a rule like "ends with [bot]" or a list of vendor names is a second, weaker
 * classification living in the UI, and it goes stale silently as new review bots
 * appear. Santree's own drafts aren't in this list at all — they're local rows the
 * caller passes separately, which is why they need no guessing either.
 */
import type { PrComment, ReviewDraft } from "../../bindings";

export type CommentAudience = "all" | "humans" | "bots" | "santree";

export const COMMENT_AUDIENCES: CommentAudience[] = ["all", "humans", "bots", "santree"];

export const audienceLabel: Record<CommentAudience, string> = {
  all: "All",
  humans: "Humans",
  bots: "Bots",
  santree: "Santree",
};

/** How many entries each filter would show. `santree` counts drafts, not
 *  comments — it is a different source, so it is a different count. */
export function audienceCounts(
  comments: PrComment[],
  drafts: ReviewDraft[],
): Record<CommentAudience, number> {
  const bots = comments.filter((c) => c.isBot).length;
  return {
    all: comments.length + drafts.length,
    humans: comments.length - bots,
    bots,
    santree: drafts.length,
  };
}

/** The comments one filter shows. `santree` shows none — its entries are the
 *  drafts, which the caller renders from its own list. */
export function filterByAudience(comments: PrComment[], audience: CommentAudience): PrComment[] {
  switch (audience) {
    case "humans":
      return comments.filter((c) => !c.isBot);
    case "bots":
      return comments.filter((c) => c.isBot);
    case "santree":
      return [];
    default:
      return comments;
  }
}

/** Whether santree's own AI drafts belong under this filter. They show under
 *  "All" too: the filter answers "who is talking on this PR", and an agent that
 *  wrote five draft comments is one of the voices. */
export function showsDrafts(audience: CommentAudience): boolean {
  return audience === "all" || audience === "santree";
}
