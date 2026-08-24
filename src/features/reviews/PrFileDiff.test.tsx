import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import type { CommentTarget } from "./commentTarget";
import { PrFileDiff } from "./PrFileDiff";

vi.mock("../../theme/useResolvedTheme", () => ({ useResolvedTheme: () => "dark" }));

vi.mock("../../lib/queries", () => ({
  useAddPrInlineComment: () => ({ mutate: vi.fn(), isPending: false }),
  useGithubViewerLogin: () => ({ data: "sam" }),
  useReplyToPrThread: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPrThreadResolved: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteReviewDraft: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishReviewDrafts: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateReviewDraft: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeAll(() => {
  // @git-diff-view sizes its columns by measuring text against a 2D canvas, which
  // jsdom doesn't implement (getContext returns null and the library throws on
  // it). A fixed-width stub is all it needs to lay out.
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (t: string) => ({ width: t.length * 7 }),
  })) as unknown as HTMLCanvasElement["getContext"];
  // The open composer is measured with a ResizeObserver, which jsdom doesn't
  // implement. Nothing here depends on the sizes it would report.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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
const NO_DRAFTS: ReviewDraft[] = [];

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
        drafts={NO_DRAFTS}
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
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("pins an AI draft to its line, beside any thread there", () => {
    const draft: ReviewDraft = {
      id: "d1",
      prRepo: "acme/api",
      prNumber: 7,
      headSha: "abc123",
      path: "src/retry.ts",
      line: 42,
      startLine: null,
      onRight: true,
      body: "This retries forever.",
      suggestion: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const { container } = render(
      <PrFileDiff
        path="src/retry.ts"
        status="modified"
        patch={PATCH}
        threads={NO_THREADS}
        drafts={[draft]}
        target={TARGET}
      />,
    );

    // Under the row it anchors to, not floating somewhere below the diff: where a
    // draft *sits* is the whole reason it's readable as a review comment.
    const row = container.querySelector('span[data-line-new-num="42"]')?.closest("tr");
    expect(row?.nextElementSibling?.textContent).toContain("This retries forever.");
    expect(row?.nextElementSibling?.textContent).toContain("AI draft");
  });
});

/** The code cell of the row carrying `line` on the new side. */
function content(container: HTMLElement, line: number) {
  const span = container.querySelector(`span[data-line-new-num="${line}"]`);
  return span?.closest("tr")?.querySelector("td.diff-line-content") as HTMLElement;
}

/** The `+` of the row carrying `line` on the new side, and its line-number cell. */
function gutter(container: HTMLElement, line: number) {
  const span = container.querySelector(`span[data-line-new-num="${line}"]`);
  const cell = span?.closest("td.diff-line-num");
  return {
    cell: cell as HTMLElement,
    plus: cell?.querySelector(".diff-add-widget-wrapper") as HTMLElement,
  };
}

describe("commenting on a range", () => {
  const RANGE = ["@@ -41,0 +41,4 @@", "+one", "+two", "+three", "+four"].join("\n");

  it("presses the + and drags to cover several lines", async () => {
    // github.com's gesture. The library opens its composer on the button's
    // mousedown, which would end the drag before it starts — useGutterDrag is
    // what holds it back until mouseup. Without that, this opens on line 41.
    const { container, getByText } = render(
      <PrFileDiff
        path="a.ts"
        status="modified"
        patch={RANGE}
        threads={NO_THREADS}
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );

    fireEvent.mouseDown(gutter(container, 41).plus);
    // Nothing yet: the press is the start of a gesture, not a click.
    expect(container.querySelector("textarea")).toBeNull();

    fireEvent.mouseOver(gutter(container, 43).cell);
    fireEvent.mouseUp(document);

    await waitFor(() =>
      expect(container.textContent).toContain("Add a comment on lines R41 to R43"),
    );
    expect(getByText("Start a review")).toBeTruthy();
  });

  it("follows the drag down the code, not just the line-number column", async () => {
    // What the pointer actually crosses. The + sits on the boundary between the
    // gutter and the code, so dragging straight down from it lands on the content
    // cells — and the library only extends a range while the pointer is over the
    // line numbers, so the range stopped at the line that was pressed.
    const { container } = render(
      <PrFileDiff
        path="a.ts"
        status="modified"
        patch={RANGE}
        threads={NO_THREADS}
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );

    fireEvent.mouseDown(gutter(container, 41).plus);
    fireEvent.mouseOver(content(container, 43));
    fireEvent.mouseUp(document);

    await waitFor(() =>
      expect(container.textContent).toContain("Add a comment on lines R41 to R43"),
    );
  });

  it("still opens on one line when the + is only clicked", async () => {
    const { container } = render(
      <PrFileDiff
        path="a.ts"
        status="modified"
        patch={RANGE}
        threads={NO_THREADS}
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );

    fireEvent.mouseDown(gutter(container, 42).plus);
    fireEvent.mouseUp(document);

    await waitFor(() => expect(container.textContent).toContain("Add a comment on line R42"));
  });

  it("prefills a suggestion with every line of the range", async () => {
    const { container, getByText, getByPlaceholderText } = render(
      <PrFileDiff
        path="a.ts"
        status="modified"
        patch={RANGE}
        threads={NO_THREADS}
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );

    fireEvent.mouseDown(gutter(container, 41).plus);
    fireEvent.mouseOver(gutter(container, 42).cell);
    fireEvent.mouseUp(document);
    await waitFor(() => getByText("Suggestion"));
    fireEvent.click(getByText("Suggestion"));

    expect((getByPlaceholderText("Leave a comment") as HTMLTextAreaElement).value).toBe(
      "```suggestion\none\ntwo\n```\n",
    );
  });
});
