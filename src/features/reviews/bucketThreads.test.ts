import { describe, expect, it } from "vitest";

import type { PrThread } from "../../bindings";
import { bucketThreads } from "./bucketThreads";

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    path: "a.ts",
    line: 10,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    comments: [],
    ...over,
  };
}

describe("bucketThreads", () => {
  it("puts right-side threads on the new file and left-side ones on the old file", () => {
    const right = thread({ line: 10, onRight: true });
    const left = thread({ line: 4, onRight: false });
    const { oldFile, newFile } = bucketThreads([right, left]);

    expect(newFile).toEqual({ "10": { data: [right] } });
    expect(oldFile).toEqual({ "4": { data: [left] } });
  });

  it("keeps both sides' threads when they share a line number", () => {
    const right = thread({ line: 7, onRight: true });
    const left = thread({ line: 7, onRight: false });
    const { oldFile, newFile } = bucketThreads([right, left]);

    expect(newFile["7"].data).toEqual([right]);
    expect(oldFile["7"].data).toEqual([left]);
  });

  it("stacks several threads on one line, in order", () => {
    const first = thread({ line: 3 });
    const second = thread({ line: 3 });
    expect(bucketThreads([first, second]).newFile["3"].data).toEqual([first, second]);
  });

  it("drops threads that can't be pinned to the diff", () => {
    const unplaceable = thread({ line: null });
    const outdated = thread({ line: 12, isOutdated: true });
    const { oldFile, newFile } = bucketThreads([unplaceable, outdated]);

    expect(newFile).toEqual({});
    expect(oldFile).toEqual({});
  });

  it("keeps resolved threads (they still render, collapsed)", () => {
    const resolved = thread({ line: 5, isResolved: true });
    expect(bucketThreads([resolved]).newFile["5"].data).toEqual([resolved]);
  });
});
