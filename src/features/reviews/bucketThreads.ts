import type { PrThread } from "../../bindings";

/** Threads keyed by diff line, per side — `@git-diff-view`'s `extendData` shape. */
export interface ThreadBuckets {
  oldFile: Record<string, { data: PrThread[] }>;
  newFile: Record<string, { data: PrThread[] }>;
}

/**
 * Bucket a file's review threads by the diff line they anchor to: the new (right)
 * side for added/context lines, the old (left) side for removed lines. Outdated /
 * unplaceable threads (no line) are dropped — they can't be pinned to the current
 * diff, and the caller lists them below it instead.
 */
export function bucketThreads(threads: PrThread[]): ThreadBuckets {
  const buckets: ThreadBuckets = { oldFile: {}, newFile: {} };
  for (const t of threads) {
    if (t.line == null || t.isOutdated) continue;
    const side = t.onRight ? buckets.newFile : buckets.oldFile;
    const key = String(t.line);
    const entry = side[key] ?? { data: [] };
    entry.data.push(t);
    side[key] = entry;
  }
  return buckets;
}
