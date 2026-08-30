import { describe, expect, it } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import { bucketAnnotations } from "./bucketThreads";

/** `id` is a parameter, not a default: two threads built from one default id are
 *  structurally identical, and a `toEqual` on a list of them cannot see their
 *  order — which is exactly what "stacks several threads on one line" asserts. */
function thread(id: string, over: Partial<PrThread> = {}): PrThread {
  return {
    id,
    replyToId: "1",
    path: "a.ts",
    line: 10,
    startLine: null,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [],
    ...over,
  };
}

function draft(id: string, over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    agentKind: "Claude",
    id,
    prRepo: "acme/web",
    prNumber: 42,
    headSha: "abc1234",
    path: "a.ts",
    line: 10,
    startLine: null,
    onRight: true,
    body: "this leaks",
    suggestion: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe("bucketAnnotations", () => {
  it("puts right-side threads on the new file and left-side ones on the old file", () => {
    const right = thread("T_right", { line: 10, onRight: true });
    const left = thread("T_left", { line: 4, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([right, left]);

    expect(newFile).toEqual({ "10": { data: [{ kind: "thread", thread: right }] } });
    expect(oldFile).toEqual({ "4": { data: [{ kind: "thread", thread: left }] } });
  });

  it("keeps both sides' threads when they share a line number", () => {
    const right = thread("T_right", { line: 7, onRight: true });
    const left = thread("T_left", { line: 7, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([right, left]);

    expect(newFile["7"].data).toEqual([{ kind: "thread", thread: right }]);
    expect(oldFile["7"].data).toEqual([{ kind: "thread", thread: left }]);
  });

  it("stacks several threads on one line, in order", () => {
    const first = thread("T_first", { line: 3 });
    const second = thread("T_second", { line: 3 });
    expect(bucketAnnotations([first, second]).newFile["3"].data).toEqual([
      { kind: "thread", thread: first },
      { kind: "thread", thread: second },
    ]);
  });

  it("drops threads that can't be pinned to the diff", () => {
    const unplaceable = thread("T_unplaceable", { line: null });
    const outdated = thread("T_outdated", { line: 12, isOutdated: true });
    const { oldFile, newFile } = bucketAnnotations([unplaceable, outdated]);

    expect(newFile).toEqual({});
    expect(oldFile).toEqual({});
  });

  it("keeps resolved threads (they still render, collapsed)", () => {
    const resolved = thread("T_resolved", { line: 5, isResolved: true });
    expect(bucketAnnotations([resolved]).newFile["5"].data).toEqual([
      { kind: "thread", thread: resolved },
    ]);
  });

  it("pins AI drafts to their line too, after any thread already there", () => {
    // A posted thread outranks a draft on the same line: what someone actually
    // said should read before what an agent is proposing to say.
    const posted = thread("T_posted", { line: 8 });
    const d = draft("d1", { line: 8 });
    expect(bucketAnnotations([posted], [d]).newFile["8"].data).toEqual([
      { kind: "thread", thread: posted },
      { kind: "draft", draft: d },
    ]);
  });

  it("puts a left-side draft on the old file", () => {
    const d = draft("d2", { line: 4, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([], [d]);
    expect(oldFile["4"].data).toEqual([{ kind: "draft", draft: d }]);
    expect(newFile).toEqual({});
  });
});
