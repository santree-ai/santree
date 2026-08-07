import { SplitSide } from "@git-diff-view/react";
import { describe, expect, it } from "vitest";

import { isRightSide } from "./commentTarget";

describe("isRightSide", () => {
  // The diff viewer numbers each side of the file independently, so getting this
  // backwards doesn't fail — it silently anchors the comment to a different line
  // of a different file version.
  it("maps the diff viewer's sides onto GitHub's", () => {
    expect(isRightSide(SplitSide.new)).toBe(true);
    expect(isRightSide(SplitSide.old)).toBe(false);
  });
});
