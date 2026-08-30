/**
 * Which of a file's comments and drafts can actually be pinned to the diff on
 * screen, and which have to be listed beneath it instead.
 *
 * Extracted because two surfaces now render a PR file — the Reviews tab's file
 * card and the Trees diff — and this is exactly the rule that must not drift
 * between them. Getting it wrong in either direction is bad in a specific way:
 * hiding an unplaceable draft loses work the user hasn't read, and pinning one to
 * a line that has since moved is worse, because the comment *looks* placed while
 * pointing at unrelated code.
 */
import type { PrThread, ReviewDraft } from "../../bindings";
import { patchLineRange } from "./patchLines";

/** Threads GitHub can no longer place: outdated, or with no line at all. */
export function outdatedThreads(threads: PrThread[]): PrThread[] {
  return threads.filter((t) => t.line == null || t.isOutdated);
}

/**
 * Split a file's AI drafts into the ones that can anchor in this diff and the
 * ones that can't.
 *
 * A draft anchors only if it was written against `head` **and** its lines are
 * still inside a hunk of `patch`. Both conditions matter: the head check catches
 * a draft describing code from an earlier commit, and the hunk check catches one
 * whose line simply isn't in the diff being shown.
 */
export function splitDrafts(
  drafts: ReviewDraft[],
  head: string,
  patch: string | null | undefined,
): { placeable: ReviewDraft[]; unplaceable: ReviewDraft[] } {
  const placeable = drafts.filter(
    (d) =>
      d.headSha === head &&
      !!patch &&
      patchLineRange(patch, d.onRight, d.startLine ?? d.line, d.line) !== null,
  );
  const placeableIds = new Set(placeable.map((d) => d.id));
  return { placeable, unplaceable: drafts.filter((d) => !placeableIds.has(d.id)) };
}
