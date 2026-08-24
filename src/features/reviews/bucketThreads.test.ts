import { describe, expect, it } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import { bucketAnnotations } from "./bucketThreads";

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    id: "T_1",
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

function draft(over: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    agentKind: "Claude",
    id: "d1",
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
    const right = thread({ line: 10, onRight: true });
    const left = thread({ line: 4, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([right, left]);

    expect(newFile).toEqual({ "10": { data: [{ kind: "thread", thread: right }] } });
    expect(oldFile).toEqual({ "4": { data: [{ kind: "thread", thread: left }] } });
  });

  it("keeps both sides' threads when they share a line number", () => {
    const right = thread({ line: 7, onRight: true });
    const left = thread({ line: 7, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([right, left]);

    expect(newFile["7"].data).toEqual([{ kind: "thread", thread: right }]);
    expect(oldFile["7"].data).toEqual([{ kind: "thread", thread: left }]);
  });

  it("stacks several threads on one line, in order", () => {
    const first = thread({ line: 3 });
    const second = thread({ line: 3 });
    expect(bucketAnnotations([first, second]).newFile["3"].data).toEqual([
      { kind: "thread", thread: first },
      { kind: "thread", thread: second },
    ]);
  });

  it("drops threads that can't be pinned to the diff", () => {
    const unplaceable = thread({ line: null });
    const outdated = thread({ line: 12, isOutdated: true });
    const { oldFile, newFile } = bucketAnnotations([unplaceable, outdated]);

    expect(newFile).toEqual({});
    expect(oldFile).toEqual({});
  });

  it("keeps resolved threads (they still render, collapsed)", () => {
    const resolved = thread({ line: 5, isResolved: true });
    expect(bucketAnnotations([resolved]).newFile["5"].data).toEqual([
      { kind: "thread", thread: resolved },
    ]);
  });

  it("pins AI drafts to their line too, after any thread already there", () => {
    // A posted thread outranks a draft on the same line: what someone actually
    // said should read before what an agent is proposing to say.
    const posted = thread({ line: 8 });
    const d = draft({ line: 8 });
    expect(bucketAnnotations([posted], [d]).newFile["8"].data).toEqual([
      { kind: "thread", thread: posted },
      { kind: "draft", draft: d },
    ]);
  });

  it("puts a left-side draft on the old file", () => {
    const d = draft({ line: 4, onRight: false });
    const { oldFile, newFile } = bucketAnnotations([], [d]);
    expect(oldFile["4"].data).toEqual([{ kind: "draft", draft: d }]);
    expect(newFile).toEqual({});
  });
});
