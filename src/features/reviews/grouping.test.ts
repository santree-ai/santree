import { describe, expect, it } from "vitest";

import type { ReviewPr } from "../../bindings";
import { inboxOfProject, type StackedPr, stackGuides, stackPrs } from "./grouping";

function pr(over: Partial<ReviewPr> = {}): ReviewPr {
  return {
    id: "node-1",
    number: 1,
    title: "A change",
    url: "https://github.com/acme/web/pull/1",
    repo: "acme/web",
    project: null,
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
describe("inboxOfProject", () => {
  const inbox = {
    mine: [pr({ id: "m1", project: "acme/web" }), pr({ id: "m2", project: "acme/kubernetes" })],
    requested: [pr({ id: "r1", project: "acme/web" }), pr({ id: "r2", project: null })],
    teams: [
      { org: "acme", slug: "eng", name: "Eng", prs: [pr({ id: "t1", project: "acme/web" })] },
      {
        org: "acme",
        slug: "ops",
        name: "Ops",
        prs: [pr({ id: "t2", project: "acme/kubernetes" })],
      },
    ],
    projects: [
      { repo: "acme/web", slug: "acme/web" },
      { repo: "acme/kubernetes", slug: "acme/kubernetes" },
    ],
    orgs: ["acme"],
    githubConnected: true,
  };

  it("keeps only one project's PRs, `mine` included", () => {
    const scoped = inboxOfProject(inbox, "acme/web");
    expect(scoped.mine.map((p) => p.id)).toEqual(["m1"]);
    expect(scoped.requested.map((p) => p.id)).toEqual(["r1"]);
    expect(scoped.teams.map((t) => t.slug)).toEqual(["eng"]);
  });

  /** A team left with nothing is dropped rather than rendered as an empty
   *  heading — the same reason the categories drop their own empty sections. */
  it("drops a team that has nothing left in this project", () => {
    expect(inboxOfProject(inbox, "acme/kubernetes").teams.map((t) => t.slug)).toEqual(["ops"]);
  });

  /** `null` is a scope of its own, not "no scope": it is how the other-repos band
   *  gets its rows instead of a leftover pile. */
  it("matches the unowned PRs on a null project", () => {
    expect(inboxOfProject(inbox, null).requested.map((p) => p.id)).toEqual(["r2"]);
  });
});

/**
 * The connector's rules, which is where "stacked" stops being a list order and
 * becomes a picture. Written as the figure each row draws, because that is what
 * a reader checks: `└` for a last child, `├` for one with a sibling below, and a
 * blank column where a branch has already ended.
 */
describe("stackGuides", () => {
  /** `└` all the way down. The bug this replaced drew a rule at column 0 through
   *  C's row — under a B that nothing else hangs off — and stopped B's own at its
   *  elbow, so the guide broke and restarted a few pixels lower. */
  it("draws nothing under a last child, at any depth", () => {
    expect(stackGuides([{ depth: 0 }, { depth: 1 }, { depth: 2 }] as StackedPr[])).toEqual([
      [],
      [false],
      [false, false],
    ]);
  });

  /** A PR with a sibling still to come continues through its own elbow. */
  it("continues a column while the branch that owns it has more below", () => {
    expect(stackGuides([{ depth: 0 }, { depth: 1 }, { depth: 1 }] as StackedPr[])).toEqual([
      [],
      [true],
      [false],
    ]);
  });

  /** The ancestor's rule runs past its child's descendants — that is the one
   *  case where a column is drawn on a row it does not belong to. */
  it("keeps an ancestor's rule alive through its child's own stack", () => {
    expect(
      stackGuides([{ depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 1 }] as StackedPr[]),
    ).toEqual([[], [true], [true, false], [false]]);
  });

  /** Back out to a root and the deeper columns are closed, not carried. */
  it("closes every column deeper than the row it reaches", () => {
    expect(
      stackGuides([{ depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 0 }] as StackedPr[]),
    ).toEqual([[], [false], [false, false], []]);
  });

  it("has nothing to draw for a flat list", () => {
    expect(stackGuides([{ depth: 0 }, { depth: 0 }] as StackedPr[])).toEqual([[], []]);
  });
});
