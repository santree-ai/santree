import { describe, expect, it } from "vitest";

import type { PrComment } from "../../bindings";
import { timelineEntries } from "./timeline";

function comment(over: Partial<PrComment> = {}): PrComment {
  return {
    author: "grace",
    authorAvatarUrl: "",
    body: "looks good",
    createdAt: "2026-08-24T10:00:00Z",
    kind: "Issue",
    path: null,
    isPending: false,
    isBot: false,
    ...over,
  };
}

describe("timelineEntries", () => {
  it("carries the comments in the order the backend sorted them", () => {
    const entries = timelineEntries([
      comment({ author: "grace", body: "first" }),
      comment({ author: "alan", body: "second" }),
    ]);

    expect(entries.map((e) => e.body)).toEqual(["first", "second"]);
    expect(entries.map((e) => e.author)).toEqual(["grace", "alan"]);
  });

  /** The regression this file exists for: the description used to be entry #1,
   *  authored by the PR's author, in the same card shape as every reply — which
   *  read as the author's opening remark rather than as the proposal. */
  it("leaves the PR's description out — it is what the comments are about", () => {
    expect(timelineEntries([])).toEqual([]);
  });

  it("keys each comment by who, when and where in the list, since GitHub gives it no id", () => {
    const [a, b] = timelineEntries([comment(), comment()]);
    expect(a.key).not.toBe(b.key);
  });

  it("carries a comment's bot flag through", () => {
    const [human, bot] = timelineEntries([comment(), comment({ isBot: true })]);
    expect(human.isBot).toBe(false);
    expect(bot.isBot).toBe(true);
  });

  it("words a review summary as reviewed and a plain comment as commented", () => {
    const [review, issue] = timelineEntries([
      comment({ kind: "Review" }),
      comment({ kind: "Issue" }),
    ]);
    expect(review.verb).toBe("reviewed");
    expect(issue.verb).toBe("commented");
  });
});
