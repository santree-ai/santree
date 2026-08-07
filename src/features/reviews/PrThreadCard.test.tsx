import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PrComment, PrDetail, PrThread } from "../../bindings";
import { PrThreadCard } from "./PrThreadCard";
import { draftCount } from "./ReviewSubmitBar";

const spies = vi.hoisted(() => ({ reply: vi.fn(), resolve: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useReplyToPrThread: () => ({ mutate: spies.reply, isPending: false }),
  useSetPrThreadResolved: () => ({ mutate: spies.resolve, isPending: false }),
}));

function comment(over: Partial<PrComment> = {}): PrComment {
  return {
    author: "sam",
    authorAvatarUrl: "",
    body: "This drops the retry budget.",
    createdAt: "2026-08-01T10:00:00Z",
    kind: "ReviewThread",
    path: "src/retry.ts",
    isPending: false,
    ...over,
  };
}

function thread(over: Partial<PrThread> = {}): PrThread {
  return {
    id: "PRRT_1",
    replyToId: "2317450981",
    path: "src/retry.ts",
    line: 42,
    onRight: true,
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    comments: [comment()],
    ...over,
  };
}

const card = (t: PrThread) => render(<PrThreadCard thread={t} prRepo="acme/api" number={7} />);

describe("PrThreadCard", () => {
  it("replies under the thread's root comment", () => {
    const { getByText, getByPlaceholderText } = card(thread());
    fireEvent.click(getByText("Reply"));

    const box = getByPlaceholderText("Write a reply…");
    fireEvent.change(box, { target: { value: "  Good catch — fixing.  " } });
    fireEvent.click(getByText("Reply"));

    // The *root* comment id, not the thread node id: GitHub threads replies off
    // the first comment, and the body is trimmed before it goes out.
    expect(spies.reply).toHaveBeenCalledWith(
      { replyToId: "2317450981", body: "Good catch — fixing." },
      expect.anything(),
    );
  });

  it("keeps the draft when the post hasn't confirmed", () => {
    const { getByText, getByPlaceholderText } = card(thread());
    fireEvent.click(getByText("Reply"));
    const box = getByPlaceholderText("Write a reply…") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half a thought" } });
    fireEvent.click(getByText("Reply"));

    // The mutation's onSuccess never fired, so what was typed must still be
    // there — a rejected comment that also wiped the box loses the user's words.
    expect(box.value).toBe("half a thought");
  });

  it("offers to resolve an open thread and to reopen a resolved one", () => {
    const { getByText } = card(thread());
    fireEvent.click(getByText("Resolve"));
    expect(spies.resolve).toHaveBeenCalledWith({ threadId: "PRRT_1", resolved: true });

    // A resolved thread starts collapsed, so its header has to be opened first.
    const resolved = card(thread({ isResolved: true }));
    fireEvent.click(resolved.getByTitle("Expand conversation"));
    fireEvent.click(resolved.getByText("Unresolve"));
    expect(spies.resolve).toHaveBeenCalledWith({ threadId: "PRRT_1", resolved: false });
  });

  it("hides resolve when GitHub says the viewer can't", () => {
    const { queryByText } = card(thread({ viewerCanResolve: false }));
    expect(queryByText("Resolve")).toBeNull();
  });

  it("hides reply when there's no root comment to reply under", () => {
    const { queryByText } = card(thread({ replyToId: "" }));
    expect(queryByText("Reply")).toBeNull();
  });

  it("marks an unsubmitted comment as a draft, with nothing to act on", () => {
    const { getByText, queryByText } = card(
      thread({ comments: [comment({ isPending: true, author: "you" })] }),
    );
    // The PR's author can't see this yet; saying so is the whole point.
    expect(getByText("Draft")).toBeTruthy();
    expect(queryByText("Reply")).toBeNull();
    expect(queryByText("Resolve")).toBeNull();
  });
});

describe("draftCount", () => {
  const detail = (threads: PrThread[]): PrDetail => ({
    body: "",
    labels: [],
    comments: [],
    threads,
    files: [],
    filesTruncated: false,
    checks: [],
    baseSha: "",
    headSha: "",
    pendingReviewId: "PRR_1",
  });

  it("counts draft comments, not threads", () => {
    // A draft reply can sit under posted comments, so the count has to look
    // inside each thread rather than at whether the thread itself is a draft.
    expect(
      draftCount(
        detail([
          thread({ comments: [comment({ isPending: true })] }),
          thread({ comments: [comment(), comment({ isPending: true })] }),
          thread({ comments: [comment()] }),
        ]),
      ),
    ).toBe(2);
  });

  it("is zero with nothing pending, and on an unloaded detail", () => {
    expect(draftCount(detail([thread()]))).toBe(0);
    expect(draftCount(undefined)).toBe(0);
  });
});
