/**
 * A pull request's anchored feedback — every posted review thread and every
 * AI-written draft — as one list.
 *
 * They used to be two sections stacked on the conversation, "Review comments"
 * and "AI suggested comments", which split one question across two places: what
 * has been said about this code. The AI is a reviewer of this pull request like
 * any other, so its comments belong in the review comments, and who wrote one is
 * a property of the row (santree's mark on the AI's) rather than of which
 * heading it sits under.
 *
 * Ordered by where an entry points, not by who wrote it — a draft on
 * `parser.py:88` sits with the thread on `parser.py:80` instead of a screen
 * below it. A file-level entry (GitHub could not place the thread on a line)
 * leads its file, since it is about all of it. Where two land on the same line,
 * what has already been said comes before what is only proposed.
 */
import type { PrThread, ReviewDraft } from "../../bindings";

export type AnchoredEntry =
  | { kind: "thread"; key: string; path: string; line: number | null; thread: PrThread }
  | { kind: "draft"; key: string; path: string; line: number | null; draft: ReviewDraft };

export function anchoredFeedback(threads: PrThread[], drafts: ReviewDraft[]): AnchoredEntry[] {
  const entries: AnchoredEntry[] = [
    // A thread carries no id of its own that survives a refetch reliably, so the
    // key is what identifies it on the page: where it points, and its place in
    // the backend's list.
    ...threads.map<AnchoredEntry>((thread, i) => ({
      kind: "thread",
      key: `thread:${thread.path}:${thread.line}:${i}`,
      path: thread.path,
      line: thread.line,
      thread,
    })),
    ...drafts.map<AnchoredEntry>((draft) => ({
      kind: "draft",
      key: `draft:${draft.id}`,
      path: draft.path,
      line: draft.line,
      draft,
    })),
  ];
  // `sort` is stable, so entries that agree on all three keys keep the order
  // their source gave them.
  return entries.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? -1) - (b.line ?? -1) ||
      rank(a.kind) - rank(b.kind),
  );
}

function rank(kind: AnchoredEntry["kind"]): number {
  return kind === "thread" ? 0 : 1;
}
