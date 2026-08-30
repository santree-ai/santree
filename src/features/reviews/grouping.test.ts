import { describe, expect, it } from "vitest";

import type { ReviewPr, TicketRef } from "../../bindings";
import {
  groupPrs,
  groupPrsByMilestone,
  NO_MILESTONE,
  NO_PROJECT,
  sizeOf,
  sortPrs,
  splitByStance,
  stackPrs,
  stanceOf,
  waitingDays,
  waitingLabel,
} from "./grouping";

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    id: "node-1",
    number: 1,
    title: "A change",
    url: "https://github.com/acme/web/pull/1",
    repo: "acme/web",
    headRef: "user/ak-1-thing",
    headRefId: null,
    baseRef: "main",
    baseRefId: null,
    headSha: "abc1234",
    author: "someone",
    authorAvatarUrl: "",
    state: "Open",
    isDraft: false,
    reviewDecision: "ReviewRequired",
    checks: "Success",
    isInMergeQueue: false,
    additions: 10,
    deletions: 5,
    changedFiles: 1,
    commentCount: 0,
    aiDraftCount: 0,
    reviewers: [],
    updatedAt: "2026-08-05T00:00:00Z",
    createdAt: "2026-08-01T00:00:00Z",
    waitingSince: "2026-08-01T00:00:00Z",
    headCommittedAt: "2026-08-01T00:00:00Z",
    viewerReview: null,
    ...over,
  };
}

describe("stanceOf", () => {
  it("puts a PR you haven't reviewed on you", () => {
    expect(stanceOf(pr())).toBe("waiting-on-you");
  });

  it("clears a PR once you've reviewed the current code", () => {
    expect(
      stanceOf(
        pr({
          headCommittedAt: "2026-08-01T00:00:00Z",
          viewerReview: { state: "Approved", submittedAt: "2026-08-02T00:00:00Z" },
        }),
      ),
    ).toBe("reviewed");
  });

  it("brings it back when the author pushes after your review", () => {
    // The review you left was of code that no longer exists.
    expect(
      stanceOf(
        pr({
          headCommittedAt: "2026-08-04T00:00:00Z",
          viewerReview: { state: "ChangesRequested", submittedAt: "2026-08-02T00:00:00Z" },
        }),
      ),
    ).toBe("waiting-on-you");
  });

  it("ignores activity that isn't a new commit", () => {
    // A comment, a label, or a CI re-run all bump `updatedAt` — none of them mean
    // there's new code for you to look at.
    expect(
      stanceOf(
        pr({
          updatedAt: "2026-08-09T00:00:00Z",
          headCommittedAt: "2026-08-01T00:00:00Z",
          viewerReview: { state: "Approved", submittedAt: "2026-08-02T00:00:00Z" },
        }),
      ),
    ).toBe("reviewed");
  });
});

describe("splitByStance", () => {
  it("separates the two buckets and keeps input order", () => {
    const a = pr({ id: "a" });
    const b = pr({
      id: "b",
      viewerReview: { state: "Approved", submittedAt: "2026-08-02T00:00:00Z" },
    });
    const c = pr({ id: "c" });
    const { waiting, reviewed } = splitByStance([a, b, c]);
    expect(waiting.map((p) => p.id)).toEqual(["a", "c"]);
    expect(reviewed.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("waitingDays", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");

  it("floors to whole days since you were asked", () => {
    expect(waitingDays(pr({ waitingSince: "2026-08-06T00:00:00Z" }), now)).toBe(2);
    expect(waitingDays(pr({ waitingSince: "2026-08-08T09:00:00Z" }), now)).toBe(0);
  });

  it("never goes negative for a clock skew", () => {
    expect(waitingDays(pr({ waitingSince: "2026-08-09T00:00:00Z" }), now)).toBe(0);
  });

  it("treats an unparseable timestamp as brand new, not as 1970", () => {
    // Otherwise a malformed value sorts to the very top of the queue forever.
    expect(waitingDays(pr({ waitingSince: "" }), now)).toBe(0);
  });
});

describe("waitingLabel", () => {
  it("reads naturally at each scale", () => {
    expect(waitingLabel(0)).toBe("today");
    expect(waitingLabel(1)).toBe("1d");
    expect(waitingLabel(13)).toBe("13d");
    expect(waitingLabel(14)).toBe("2w");
  });
});

describe("sizeOf", () => {
  it("scales with the diff", () => {
    expect(sizeOf(pr({ additions: 3, deletions: 1, changedFiles: 1 }))).toBe("XS");
    expect(sizeOf(pr({ additions: 80, deletions: 20, changedFiles: 3 }))).toBe("S");
    expect(sizeOf(pr({ additions: 900, deletions: 400, changedFiles: 40 }))).toBe("XL");
  });

  it("counts spread, not just line count", () => {
    // Same 300 lines: one file is a sitting, thirty is an afternoon.
    const focused = pr({ additions: 300, deletions: 0, changedFiles: 1 });
    const scattered = pr({ additions: 300, deletions: 0, changedFiles: 30 });
    expect(sizeOf(focused)).toBe("M");
    expect(sizeOf(scattered)).toBe("L");
  });
});

describe("sortPrs", () => {
  const old = pr({ id: "old", waitingSince: "2026-08-01T00:00:00Z", updatedAt: "2026-08-02Z" });
  const fresh = pr({ id: "fresh", waitingSince: "2026-08-07T00:00:00Z", updatedAt: "2026-08-09Z" });

  it("puts the longest wait first", () => {
    expect(sortPrs([fresh, old], "waiting").map((p) => p.id)).toEqual(["old", "fresh"]);
  });

  it("puts the most recent activity first when sorting by update", () => {
    expect(sortPrs([old, fresh], "updated").map((p) => p.id)).toEqual(["fresh", "old"]);
  });

  it("puts the quickest review first when sorting by size", () => {
    const big = pr({ id: "big", additions: 900, changedFiles: 30 });
    const small = pr({ id: "small", additions: 4, changedFiles: 1 });
    expect(sortPrs([big, small], "size").map((p) => p.id)).toEqual(["small", "big"]);
  });

  it("breaks ties deterministically so the list can't shuffle between refetches", () => {
    const a = pr({ id: "a" });
    const b = pr({ id: "b" });
    expect(sortPrs([b, a], "waiting").map((p) => p.id)).toEqual(["a", "b"]);
    expect(sortPrs([a, b], "waiting").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("doesn't mutate its input", () => {
    const list = [fresh, old];
    sortPrs(list, "waiting");
    expect(list.map((p) => p.id)).toEqual(["fresh", "old"]);
  });
});

describe("groupPrs", () => {
  const ticket = (over: Partial<TicketRef>): TicketRef => ({
    identifier: "AK-1",
    title: "t",
    priority: "None",
    project: "Roadmap",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: null,
    ...over,
  });

  it("groups by repo and names the block after the repo, not the slug", () => {
    const groups = groupPrs(
      [pr({ id: "1", repo: "acme/web" }), pr({ id: "2", repo: "acme/api" })],
      "repo",
      "waiting",
      () => undefined,
    );
    expect(groups.map((g) => g.label).sort()).toEqual(["api", "web"]);
  });

  it("groups by Linear project and carries its color and icon through", () => {
    const groups = groupPrs([pr({ id: "1" })], "project", "waiting", () =>
      ticket({ project: "Voice", projectColor: "#abc", projectIcon: "🎙" }),
    );
    expect(groups[0]).toMatchObject({ label: "Voice", color: "#abc", icon: "🎙" });
  });

  it("keeps PRs with no ticket rather than dropping them", () => {
    // An inbox that silently hides rows is worse than an untidy one.
    const groups = groupPrs([pr({ id: "1" })], "project", "waiting", () => undefined);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(NO_PROJECT);
    expect(groups[0].prs.map((p) => p.id)).toEqual(["1"]);
  });

  it("sinks the catch-all block below real projects however old its contents", () => {
    const groups = groupPrs(
      [
        pr({ id: "ancient", waitingSince: "2020-01-01T00:00:00Z" }),
        pr({ id: "recent", waitingSince: "2026-08-07T00:00:00Z" }),
      ],
      "project",
      "waiting",
      (p) => (p.id === "recent" ? ticket({ project: "Voice" }) : undefined),
    );
    expect(groups.map((g) => g.label)).toEqual(["Voice", NO_PROJECT]);
  });

  it("orders blocks by their most-waiting member", () => {
    const groups = groupPrs(
      [
        pr({ id: "1", waitingSince: "2026-08-07T00:00:00Z" }),
        pr({ id: "2", waitingSince: "2026-08-01T00:00:00Z" }),
      ],
      "project",
      "waiting",
      (p) => ticket({ project: p.id === "1" ? "Fresh" : "Stale" }),
    );
    expect(groups.map((g) => g.label)).toEqual(["Stale", "Fresh"]);
  });

  it("sorts within each block too", () => {
    const groups = groupPrs(
      [
        pr({ id: "new", waitingSince: "2026-08-07T00:00:00Z" }),
        pr({ id: "old", waitingSince: "2026-08-01T00:00:00Z" }),
      ],
      "repo",
      "waiting",
      () => undefined,
    );
    expect(groups[0].prs.map((p) => p.id)).toEqual(["old", "new"]);
  });
});

describe("groupPrsByMilestone", () => {
  const ticket = (id: string, name: string, sortOrder: number): TicketRef => ({
    identifier: "AK-1",
    title: "t",
    priority: "None",
    project: "Roadmap",
    projectColor: null,
    projectIcon: null,
    projectTargetDate: null,
    projectMilestone: { id, name, targetDate: null, sortOrder },
  });

  it("uses Linear's manual order and sinks unassigned PRs", () => {
    const prs = [pr({ id: "none" }), pr({ id: "later" }), pr({ id: "first" })];
    const groups = groupPrsByMilestone(prs, (item) => {
      if (item.id === "first") return ticket("m1", "Alpha", 10);
      if (item.id === "later") return ticket("m2", "Beta", 20);
      return undefined;
    });
    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta", NO_MILESTONE]);
    expect(groups.at(-1)?.prs.map((item) => item.id)).toEqual(["none"]);
  });

  it("keys same-named milestones by id", () => {
    const groups = groupPrsByMilestone([pr({ id: "a" }), pr({ id: "b" })], (item) =>
      ticket(item.id === "a" ? "m1" : "m2", "Launch", item.id === "a" ? 1 : 2),
    );
    expect(groups.map((group) => group.key)).toEqual(["m1", "m2"]);
  });
});

describe("stackPrs", () => {
  it("places a child directly below the PR whose head ref it targets", () => {
    const parent = pr({ id: "parent", headRefId: "REF-parent" });
    const sibling = pr({ id: "sibling", headRefId: "REF-sibling" });
    const child = pr({ id: "child", headRefId: "REF-child", baseRefId: "REF-parent" });
    expect(
      stackPrs([parent, sibling, child]).map(({ pr: item, depth }) => [item.id, depth]),
    ).toEqual([
      ["parent", 0],
      ["child", 1],
      ["sibling", 0],
    ]);
  });

  it("does not connect same-named refs with different GitHub identities", () => {
    const parent = pr({ id: "parent", headRef: "feature", headRefId: "REF-a" });
    const child = pr({ id: "child", baseRef: "feature", baseRefId: "REF-b" });
    expect(stackPrs([parent, child]).map(({ depth }) => depth)).toEqual([0, 0]);
  });

  it("caps deep indentation and never drops cycles", () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      pr({
        id: `p${index}`,
        headRefId: `REF-${index}`,
        baseRefId: index === 0 ? null : `REF-${index - 1}`,
      }),
    );
    expect(stackPrs(chain).map(({ depth }) => depth)).toEqual([0, 1, 2, 3, 3, 3]);

    const a = pr({ id: "a", headRefId: "A", baseRefId: "B" });
    const b = pr({ id: "b", headRefId: "B", baseRefId: "A" });
    expect(
      stackPrs([a, b])
        .map(({ pr: item }) => item.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
