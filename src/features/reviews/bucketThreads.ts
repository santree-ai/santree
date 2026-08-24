import type { PrThread, ReviewDraft } from "../../bindings";

/** One thing pinned to a diff line: a real review thread, or one of the AI
 *  review's drafts. Tagged rather than merged into a common shape — they render
 *  differently and mean different things, and flattening a draft into a
 *  thread-shaped object is how a draft ends up looking posted. */
export type DiffAnnotation =
  | { kind: "thread"; thread: PrThread }
  | { kind: "draft"; draft: ReviewDraft };

/** Annotations keyed by diff line, per side — `@git-diff-view`'s `extendData` shape. */
export interface AnnotationBuckets {
  oldFile: Record<string, { data: DiffAnnotation[] }>;
  newFile: Record<string, { data: DiffAnnotation[] }>;
}

/**
 * Bucket a file's threads and drafts by the diff line they anchor to: the new
 * (right) side for added/context lines, the old (left) side for removed lines.
 * Outdated / unplaceable threads (no line) are dropped — they can't be pinned to
 * the current diff, and the caller lists them below it instead. The same goes for
 * drafts the caller has already judged unplaceable.
 *
 * Threads come first on a shared line: what's been said publicly outranks what an
 * agent is proposing to say.
 */
export function bucketAnnotations(
  threads: PrThread[],
  drafts: ReviewDraft[] = [],
): AnnotationBuckets {
  const buckets: AnnotationBuckets = { oldFile: {}, newFile: {} };
  const put = (onRight: boolean, line: number, item: DiffAnnotation) => {
    const side = onRight ? buckets.newFile : buckets.oldFile;
    const key = String(line);
    const entry = side[key] ?? { data: [] };
    entry.data.push(item);
    side[key] = entry;
  };
  for (const thread of threads) {
    if (thread.line == null || thread.isOutdated) continue;
    put(thread.onRight, thread.line, { kind: "thread", thread });
  }
  for (const draft of drafts) {
    put(draft.onRight, draft.line, { kind: "draft", draft });
  }
  return buckets;
}
