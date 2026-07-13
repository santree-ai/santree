import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrDetail, PrFile, ReviewedFile, ReviewPr } from "../../bindings";
import { PrReviewPane } from "./PrReviewPane";

// Counts how often a file card actually re-renders: the diff is rendered *inside*
// PrFileCard, so a call here means the memo let a render through.
const spies = vi.hoisted(() => ({ renderDiff: vi.fn(), mutate: vi.fn() }));

vi.mock("./PrFileDiff", () => ({
  PrFileDiff: ({ path }: { path: string }) => {
    spies.renderDiff(path);
    return <div data-testid={`diff-${path}`} />;
  },
}));

vi.mock("../../lib/queries", () => ({
  usePrDetail: () => ({ data: detail, isLoading: false }),
  usePrFileSource: () => ({ data: undefined }),
  useReviewedFiles: () => ({ data: reviewed }),
  useSetFileReviewed: () => ({ mutate: spies.mutate }),
}));

function file(path: string): PrFile {
  return {
    path,
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: `@@ -1 +1 @@\n-old\n+new`,
    sha: `sha-${path}`,
  };
}

const detail: PrDetail = {
  body: "",
  labels: [],
  comments: [],
  threads: [],
  files: [file("a.ts"), file("b.ts")],
  filesTruncated: false,
  checks: [],
  baseSha: "base",
  headSha: "head",
};

let reviewed: ReviewedFile[] = [];

function pr(overrides: Partial<ReviewPr> = {}): ReviewPr {
  return {
    id: "m1",
    number: 483,
    title: "Booking webhook retries",
    url: "https://github.com/acme/booking-agent/pull/483",
    repo: "acme/booking-agent",
    headRef: "you/pr-483",
    author: "you",
    authorAvatarUrl: "",
    state: "Open",
    isDraft: false,
    reviewDecision: "ReviewRequired",
    checks: "Success",
    isInMergeQueue: false,
    additions: 10,
    deletions: 2,
    commentCount: 0,
    reviewers: [],
    updatedAt: "2026-06-29T12:00:00Z",
    ...overrides,
  };
}

describe("PrReviewPane", () => {
  it("keeps the file cards memoized across an unrelated re-render", () => {
    reviewed = [];
    const { rerender } = render(<PrReviewPane pr={pr()} />);
    expect(spies.renderDiff).toHaveBeenCalledTimes(2);
    spies.renderDiff.mockClear();

    // What the 30s check-poll does: a fresh ReviewPr object whose files/threads are
    // unchanged. Every prop the cards receive must still be reference-stable.
    rerender(<PrReviewPane pr={pr({ checks: "Pending", commentCount: 4 })} />);
    expect(spies.renderDiff).not.toHaveBeenCalled();
  });

  it("re-renders only the file whose Viewed mark changed", () => {
    reviewed = [];
    const { rerender } = render(<PrReviewPane pr={pr()} />);
    spies.renderDiff.mockClear();

    reviewed = [{ path: "a.ts", sha: "sha-a.ts" }];
    rerender(<PrReviewPane pr={pr()} />);

    // a.ts re-renders (then collapses); b.ts's memo must hold — no re-layout of a
    // diff the user didn't touch.
    expect(spies.renderDiff.mock.calls.flat()).not.toContain("b.ts");
  });
});
