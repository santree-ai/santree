import { describe, expect, it } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import { anchoredFeedback } from "./anchoredFeedback";

function thread(path: string, line: number | null, id = path): PrThread {
  return { id, path, line, comments: [{ body: "posted" }] } as unknown as PrThread;
}

function draft(path: string, line: number, id = `${path}:${line}`): ReviewDraft {
  return { id, path, line, body: "proposed" } as unknown as ReviewDraft;
}

describe("anchoredFeedback", () => {
  /** The whole point of the merge: the AI's comment on a file sits with what
   *  people already said about that file, not in a section below all of them. */
  it("interleaves drafts with threads by where they point", () => {
    const entries = anchoredFeedback(
      [thread("src/a.ts", 10), thread("src/b.ts", 4)],
      [draft("src/a.ts", 40), draft("src/b.ts", 2)],
    );
    expect(entries.map((e) => `${e.kind}:${e.path}:${e.line}`)).toEqual([
      "thread:src/a.ts:10",
      "draft:src/a.ts:40",
      "draft:src/b.ts:2",
      "thread:src/b.ts:4",
    ]);
  });

  /** GitHub can lose a thread's line (an outdated thread on since-changed code).
   *  It is about the whole file then, so it leads it rather than sorting as line
   *  zero somewhere in the middle. */
  it("puts a thread with no line at the head of its file", () => {
    const entries = anchoredFeedback([thread("src/a.ts", 3), thread("src/a.ts", null, "t2")], []);
    expect(entries.map((e) => e.line)).toEqual([null, 3]);
  });

  /** Two entries on one line: what has been said outranks what is only proposed. */
  it("orders a posted thread before a draft on the same line", () => {
    const entries = anchoredFeedback([thread("src/a.ts", 7)], [draft("src/a.ts", 7)]);
    expect(entries.map((e) => e.kind)).toEqual(["thread", "draft"]);
  });

  it("keeps the source order of entries that agree on all of it", () => {
    const entries = anchoredFeedback([], [draft("src/a.ts", 7, "d1"), draft("src/a.ts", 7, "d2")]);
    expect(entries.map((e) => e.key)).toEqual(["draft:d1", "draft:d2"]);
  });

  it("has nothing to list for a PR with neither", () => {
    expect(anchoredFeedback([], [])).toEqual([]);
  });
});
