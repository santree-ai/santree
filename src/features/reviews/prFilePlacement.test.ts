import { describe, expect, it } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import { outdatedThreads, splitDrafts } from "./prFilePlacement";

// new side: 10 → "const a = 1;", 11 → "const b = 2;", 12 → "const c = 3;",
// 13 → "const d = 4;".
const PATCH = [
  "@@ -10,2 +10,4 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
].join("\n");

const HEAD = "abc123";

function draft(id: string, over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    agentKind: "Claude",
    id,
    prRepo: "acme/api",
    prNumber: 7,
    headSha: HEAD,
    path: "src/retry.ts",
    line: 11,
    startLine: null,
    onRight: true,
    body: "",
    suggestion: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    id: "t1",
    replyToId: "1",
    path: "src/retry.ts",
    line: 11,
    startLine: null,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: [],
    ...over,
  };
}

describe("splitDrafts", () => {
  it("places a draft written against this head on a line the diff contains", () => {
    const { placeable, unplaceable } = splitDrafts([draft("d1")], HEAD, PATCH);
    expect(placeable.map((d) => d.id)).toEqual(["d1"]);
    expect(unplaceable).toEqual([]);
  });

  // Its line numbers describe code from an earlier commit, so anchoring it would
  // put the comment on whatever now occupies that line.
  it("won't place a draft written against an older head", () => {
    const stale = draft("d1", { headSha: "older" });
    const { placeable, unplaceable } = splitDrafts([stale], HEAD, PATCH);
    expect(placeable).toEqual([]);
    expect(unplaceable.map((d) => d.id)).toEqual(["d1"]);
  });

  it("won't place a draft on a line outside the hunks", () => {
    const outside = draft("d1", { line: 99 });
    expect(splitDrafts([outside], HEAD, PATCH).unplaceable.map((d) => d.id)).toEqual(["d1"]);
  });

  it("won't place anything on a binary file", () => {
    expect(splitDrafts([draft("d1")], HEAD, null).unplaceable).toHaveLength(1);
  });

  /** The split must be a partition: a draft that goes missing is work the user
   *  never got to read, and one counted twice renders twice. */
  it("keeps every draft in exactly one bucket", () => {
    const drafts = [
      draft("ok"),
      draft("stale", { headSha: "older" }),
      draft("offhunk", { line: 99 }),
    ];
    const { placeable, unplaceable } = splitDrafts(drafts, HEAD, PATCH);
    expect([...placeable, ...unplaceable].map((d) => d.id).sort()).toEqual([
      "offhunk",
      "ok",
      "stale",
    ]);
  });
});

describe("outdatedThreads", () => {
  it("picks out the threads GitHub can no longer place", () => {
    const threads = [
      thread({ id: "live" }),
      thread({ id: "outdated", isOutdated: true }),
      thread({ id: "unplaced", line: null }),
    ];
    expect(outdatedThreads(threads).map((t) => t.id)).toEqual(["outdated", "unplaced"]);
  });
});
