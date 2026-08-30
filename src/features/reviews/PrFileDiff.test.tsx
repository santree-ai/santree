import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PrThread, ReviewDraft } from "../../bindings";
import type { DiffMode } from "../trees/DiffViewer";
import type { CommentTarget } from "./commentTarget";
import { PrFileDiff } from "./PrFileDiff";

vi.mock("../../theme/useResolvedTheme", () => ({ useResolvedTheme: () => "dark" }));

vi.mock("../../lib/queries", () => ({
  useReviewWorkItems: () => ({ data: [] }),
  useAddReviewWorkItem: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPrInlineComment: () => ({ mutate: vi.fn(), isPending: false }),
  useGithubViewerLogin: () => ({ data: "sam" }),
  useReplyToPrThread: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPrThreadResolved: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteReviewDraft: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishReviewDrafts: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateReviewDraft: () => ({ mutate: vi.fn(), isPending: false }),
}));

beforeAll(() => {
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

  it("drops incompatible full content before it reaches the diff viewer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <PrFileDiff
        path="src/retry.ts"
        status="modified"
        patch={PATCH}
        oldText="this is not the patch's base"
        newText="this is not the patch's head"
        threads={NO_THREADS}
        drafts={NO_DRAFTS}
        target={TARGET}
      />,
    );

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Mismatch detected"));
    warn.mockRestore();
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
      agentKind: "Claude",
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

/** The row carrying `line` on the new side. Unified keeps both sides' numbers in
 *  one cell, under `data-line-<side>-num`; split gives the new side a cell of its
 *  own and numbers it `data-line-num`. */
function newRow(container: HTMLElement, mode: DiffMode, line: number) {
  const span =
    mode === "unified"
      ? container.querySelector(`span[data-line-new-num="${line}"]`)
      : container.querySelector(`td.diff-line-new-num span[data-line-num="${line}"]`);
  return span?.closest("tr") ?? null;
}

/** The code cell of the row carrying `line` on the new side. */
function content(container: HTMLElement, mode: DiffMode, line: number) {
  const cell = mode === "unified" ? "td.diff-line-content" : "td.diff-line-new-content";
  return newRow(container, mode, line)?.querySelector(cell) as HTMLElement;
}

/** That row's line-number cell and the `+` inside it. Split renders a second `+`
 *  in the code cell — `contentPlus` — which holds no line number of its own.
 *
 *  These are the `<button>`s, not their wrappers: the library's own composer-on-
 *  mousedown hangs off the button, so pressing anything else would test the drag
 *  without the handler it has to out-race. */
function gutter(container: HTMLElement, mode: DiffMode, line: number) {
  const cell = newRow(container, mode, line)?.querySelector(
    mode === "unified" ? "td.diff-line-num" : "td.diff-line-new-num",
  );
  return {
    cell: cell as HTMLElement,
    plus: cell?.querySelector(".diff-add-widget-wrapper button") as HTMLElement,
    contentPlus: content(container, mode, line)?.querySelector(
      ".diff-add-widget-wrapper button",
    ) as HTMLElement,
  };
}

// Both modes, because the gesture is DOM-shaped: the library names the line-number
// cells and their number attributes differently in each. Trees renders your own
// PR's diff split by default, Reviews takes the unified one — a hook written
// against unified selectors alone leaves half the app without the gesture.
describe.each(["unified", "split"] as const)("commenting on a range (%s)", (mode) => {
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
        mode={mode}
      />,
    );

    fireEvent.mouseDown(gutter(container, mode, 41).plus);
    // Nothing yet: the press is the start of a gesture, not a click.
    expect(container.querySelector("textarea")).toBeNull();

    fireEvent.mouseOver(gutter(container, mode, 43).cell);
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
        mode={mode}
      />,
    );

    fireEvent.mouseDown(gutter(container, mode, 41).plus);
    fireEvent.mouseOver(content(container, mode, 43));
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
        mode={mode}
      />,
    );

    fireEvent.mouseDown(gutter(container, mode, 42).plus);
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
        mode={mode}
      />,
    );

    fireEvent.mouseDown(gutter(container, mode, 41).plus);
    fireEvent.mouseOver(gutter(container, mode, 42).cell);
    fireEvent.mouseUp(document);
    await waitFor(() => getByText("Suggestion"));
    fireEvent.click(getByText("Suggestion"));

    expect((getByPlaceholderText("Leave a comment") as HTMLTextAreaElement).value).toBe(
      "```suggestion\none\ntwo\n```\n",
    );
  });

  if (mode === "split") {
    it("works from either column, on a row whose two sides disagree", async () => {
      // Split lays a deletion and its replacement on one row, and that row's two
      // number cells disagree the moment the file has shifted. Each column's
      // code-cell `+` has to resolve through its *own* side — one written against
      // the new side alone leaves every left-hand `+` dead.
      const SHIFTED = ["@@ -10,2 +20,2 @@", " ctx", "-was", "+now"].join("\n");
      const press = (container: HTMLElement, side: "old" | "new", line: number) => {
        const row = container
          .querySelector(`td.diff-line-${side}-num span[data-line-num="${line}"]`)
          ?.closest("tr");
        fireEvent.mouseDown(
          row?.querySelector(
            `td.diff-line-${side}-content .diff-add-widget-wrapper button`,
          ) as HTMLElement,
        );
        fireEvent.mouseUp(document);
      };
      const diff = (
        <PrFileDiff
          path="a.ts"
          status="modified"
          patch={SHIFTED}
          threads={NO_THREADS}
          drafts={NO_DRAFTS}
          target={TARGET}
          mode={mode}
        />
      );

      const left = render(diff);
      press(left.container, "old", 11);
      await waitFor(() =>
        expect(left.container.textContent).toContain("Add a comment on line L11"),
      );

      const right = render(diff);
      press(right.container, "new", 21);
      await waitFor(() =>
        expect(right.container.textContent).toContain("Add a comment on line R21"),
      );
    });

    it("drags from the copy of the + that sits in the code cell", async () => {
      // Split renders the button twice per row, once either side of the gutter
      // boundary, and only the gutter copy sits next to a line number. The library
      // arms a drag on both, so pressing the code-cell one has to behave the same
      // — otherwise its mousedown reaches the library's own handler, which opens
      // the composer on the pressed line and clears the range on the way.
      const { container } = render(
        <PrFileDiff
          path="a.ts"
          status="modified"
          patch={RANGE}
          threads={NO_THREADS}
          drafts={NO_DRAFTS}
          target={TARGET}
          mode={mode}
        />,
      );

      fireEvent.mouseDown(gutter(container, mode, 41).contentPlus);
      expect(container.querySelector("textarea")).toBeNull();

      fireEvent.mouseOver(content(container, mode, 43));
      fireEvent.mouseUp(document);

      await waitFor(() =>
        expect(container.textContent).toContain("Add a comment on lines R41 to R43"),
      );
    });
  }
});
