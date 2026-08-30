import { describe, expect, it } from "vitest";

import type { PrComment, ReviewDraft } from "../../bindings";
import {
  audienceCounts,
  type CommentAudience,
  filterByAudience,
  showsDrafts,
} from "./commentAudience";

function comment(author: string, isBot: boolean): PrComment {
  return {
    author,
    authorAvatarUrl: "",
    body: "",
    createdAt: "2026-08-27T00:00:00Z",
    kind: "Issue",
    path: null,
    isPending: false,
    isBot,
  };
}

function draft(id: string): ReviewDraft {
  return {
    agentKind: "Claude",
    id,
    prRepo: "acme/api",
    prNumber: 7,
    headSha: "abc",
    path: "src/api.rs",
    line: 4,
    startLine: null,
    onRight: true,
    body: "",
    suggestion: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const comments = [
  comment("someone", false),
  comment("github-actions", true),
  comment("linear-code", true),
];
const drafts = [draft("d1")];

describe("audienceCounts", () => {
  it("counts each filter, with drafts as their own source", () => {
    expect(audienceCounts(comments, drafts)).toEqual({
      all: 4,
      humans: 1,
      bots: 2,
      santree: 1,
    });
  });
});

describe("filterByAudience", () => {
  it("splits on what GitHub said, not on how the login reads", () => {
    // A person whose login looks automated stays a person, and a bot whose login
    // doesn't stays a bot — which is the whole reason the flag comes from the API.
    const tricky = [comment("renovate[bot]", false), comment("linear-code", true)];
    expect(filterByAudience(tricky, "humans").map((c) => c.author)).toEqual(["renovate[bot]"]);
    expect(filterByAudience(tricky, "bots").map((c) => c.author)).toEqual(["linear-code"]);
  });

  it("shows everything under All", () => {
    expect(filterByAudience(comments, "all")).toHaveLength(3);
  });

  it("shows no GitHub comments under Santree — those entries are the drafts", () => {
    expect(filterByAudience(comments, "santree")).toEqual([]);
  });
});

describe("showsDrafts", () => {
  it("puts santree's drafts under All and Santree only", () => {
    const shown: CommentAudience[] = ["all", "humans", "bots", "santree"].filter((a) =>
      showsDrafts(a as CommentAudience),
    ) as CommentAudience[];
    expect(shown).toEqual(["all", "santree"]);
  });
});
