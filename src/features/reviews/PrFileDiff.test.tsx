import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PrThread } from "../../bindings";
import type { CommentTarget } from "./commentTarget";
import { PrFileDiff } from "./PrFileDiff";

vi.mock("../../theme/useResolvedTheme", () => ({ useResolvedTheme: () => "dark" }));

vi.mock("../../lib/queries", () => ({
  useAddPrInlineComment: () => ({ mutate: vi.fn(), isPending: false }),
  useGithubViewerLogin: () => ({ data: "sam" }),
  useReplyToPrThread: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPrThreadResolved: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeAll(() => {
  // @git-diff-view sizes its columns by measuring text against a 2D canvas, which
  // jsdom doesn't implement (getContext returns null and the library throws on
  // it). A fixed-width stub is all it needs to lay out.
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (t: string) => ({ width: t.length * 7 }),
  })) as unknown as HTMLCanvasElement["getContext"];
});

const PATCH = ["@@ -41,2 +41,2 @@", " const a = 1;", "-const b = 1;", "+const b = 2;"].join("\n");

const TARGET: CommentTarget = {
  prRepo: "acme/api",
  number: 7,
  prId: "PR_1",
  headSha: "abc123",
  pendingReviewId: null,
};

const NO_THREADS: PrThread[] = [];

describe("PrFileDiff", () => {
  it("renders the patch through the multi-select viewer", () => {
    // Guards the component swap: the range-comment affordance only exists because
    // this is `DiffViewWithMultiSelect` rather than plain `DiffView`, and the two
    // are otherwise interchangeable enough for a regression to go unnoticed.
    const { container } = render(
      <PrFileDiff
        path="src/retry.ts"
        status="modified"
        patch={PATCH}
        threads={NO_THREADS}
        target={TARGET}
      />,
    );

    expect(container.querySelector(".diff-multiselect-wrapper")).toBeTruthy();
    expect(container.textContent).toContain("const b = 2;");
  });

  it("renders nothing for a file with no patch", () => {
    const { container } = render(
      <PrFileDiff
        path="logo.png"
        status="modified"
        patch=""
        threads={NO_THREADS}
        target={TARGET}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
