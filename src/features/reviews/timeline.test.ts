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
    reviewState: null,
    path: null,
    isPending: false,
    isBot: false,
    ...over,
  };
}

describe("timelineEntries", () => {
  it("keys each comment by who, when and where in the list, since GitHub gives it no id", () => {
    const [a, b] = timelineEntries([comment(), comment()]);
    expect(a.key).not.toBe(b.key);
  });

  /** An approved PR used to show no approval at all: bare approvals were
   *  dropped, and the ones with words read as "reviewed" with no verdict. */
  it("words a review by its verdict, and a plain comment as commented", () => {
    const [approved, changes, plain, issue] = timelineEntries([
      comment({ kind: "Review", reviewState: "Approved", body: "" }),
      comment({ kind: "Review", reviewState: "ChangesRequested" }),
      comment({ kind: "Review", reviewState: "Commented" }),
      comment({ kind: "Issue" }),
    ]);
    expect(approved.verb).toBe("approved");
    expect(approved.reviewState).toBe("Approved");
    expect(changes.verb).toBe("requested changes");
    expect(plain.verb).toBe("reviewed");
    expect(issue.verb).toBe("commented");
    expect(issue.reviewState).toBeNull();
  });
});
