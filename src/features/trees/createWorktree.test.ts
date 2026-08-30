import { describe, expect, it } from "vitest";

import type { RepoBranch } from "../../bindings";
import {
  branchPickerRows,
  createArgsFor,
  invalidBranchReason,
  worktreeIdForBranch,
} from "./createWorktree";

const branch = (name: string, hasWorktree = false, remoteOnly = false): RepoBranch => ({
  name,
  hasWorktree,
  remoteOnly,
  updatedAt: "2026-08-27T12:00:00+00:00",
});

const BRANCHES: RepoBranch[] = [
  branch("main", true),
  branch("feature/search", true),
  branch("feature/sidebar"),
  branch("hotfix/crash", false, true),
];

describe("branchPickerRows", () => {
  it("offers only branches that don't already have a worktree", () => {
    const { available, taken } = branchPickerRows(BRANCHES, "");
    expect(available.map((b) => b.name)).toEqual(["feature/sidebar", "hotfix/crash"]);
    // Still listed, so "why isn't main here?" has an answer — but not pickable.
    expect(taken.map((b) => b.name)).toEqual(["main", "feature/search"]);
  });

  it("filters case-insensitively on a substring", () => {
    const { available, taken } = branchPickerRows(BRANCHES, "FEATURE");
    expect(available.map((b) => b.name)).toEqual(["feature/sidebar"]);
    expect(taken.map((b) => b.name)).toEqual(["feature/search"]);
  });

  it("offers a create-new-branch row when the query matches nothing", () => {
    const rows = branchPickerRows(BRANCHES, "feature/create-worktree");
    expect(rows.available).toEqual([]);
    expect(rows.taken).toEqual([]);
    expect(rows.create).toEqual({ name: "feature/create-worktree", reason: null });
  });

  it("does not offer to create a branch that already exists", () => {
    expect(branchPickerRows(BRANCHES, "feature/sidebar").create).toBeNull();
    // Not even when the existing one is unavailable: the answer there is
    // "taken", not "make a second one with the same name".
    expect(branchPickerRows(BRANCHES, "main").create).toBeNull();
  });

  it("offers no create row for an empty query", () => {
    expect(branchPickerRows(BRANCHES, "   ").create).toBeNull();
  });

  it("carries the reason a typed name is unusable instead of hiding the row", () => {
    const rows = branchPickerRows(BRANCHES, "--upload-pack=/tmp/pwn");
    expect(rows.create?.name).toBe("--upload-pack=/tmp/pwn");
    expect(rows.create?.reason).toMatch(/can't start with/);
  });
});

describe("invalidBranchReason", () => {
  it("accepts the branch names git accepts", () => {
    for (const name of [
      "main",
      "feature/AK-1-do-a-thing",
      "santree/ak-165-fix",
      "release-2.0",
      "user@host",
      "a.b.c",
    ]) {
      expect(invalidBranchReason(name), name).toBeNull();
    }
  });

  it("rejects a leading dash — the name reaches a git argv positionally", () => {
    expect(invalidBranchReason("--upload-pack=/tmp/pwn")).not.toBeNull();
    expect(invalidBranchReason("-b")).not.toBeNull();
    expect(invalidBranchReason("-")).not.toBeNull();
  });

  it("rejects what git check-ref-format rejects", () => {
    for (const name of [
      "",
      "a..b",
      "a b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "feat/@{now}",
      "@",
      ".hidden",
      "feat/.hidden",
      "feat.lock",
      "feat/x.lock",
      "/leading",
      "trailing/",
      "double//slash",
      "ends.with.dot.",
      "new\nline",
    ]) {
      expect(invalidBranchReason(name), JSON.stringify(name)).not.toBeNull();
    }
  });
});

describe("worktreeIdForBranch", () => {
  it("flattens a branch into one plain path component", () => {
    expect(worktreeIdForBranch("feature/sidebar")).toBe("feature-sidebar");
    expect(worktreeIdForBranch("AK-165/Fix Thing")).toBe("ak-165-fix-thing");
  });

  it("never produces an id the backend would read as a traversal", () => {
    for (const name of ["..", "../escape", "///", "."]) {
      const id = worktreeIdForBranch(name);
      expect(id).not.toBe("");
      expect(id).not.toContain("/");
      expect(id.startsWith(".")).toBe(false);
    }
  });
});

describe("createArgsFor", () => {
  it("derives the branch name from the ticket, keeping its project", () => {
    expect(
      createArgsFor({ kind: "ticket", id: "AK-1", title: "Do a thing", project: "Booking" }, null),
    ).toEqual({
      issueId: "AK-1",
      title: "Do a thing",
      project: "Booking",
      source: { type: "derived" },
      base: null,
    });
  });

  it("checks out an existing branch under no project and no ticket", () => {
    expect(createArgsFor({ kind: "existing", branch: "feature/sidebar" }, null)).toEqual({
      issueId: "feature-sidebar",
      title: "feature/sidebar",
      project: null,
      source: { type: "existing", branch: "feature/sidebar" },
      base: null,
    });
  });

  it("creates a new branch under exactly the typed name", () => {
    const args = createArgsFor({ kind: "new", branch: "feature/brand-new" }, null);
    expect(args.source).toEqual({ type: "new", branch: "feature/brand-new" });
    expect(args.title).toBe("feature/brand-new");
  });

  it("maps the picked parent worktree onto the stacked-worktree base", () => {
    // The parent's *branch* is the base — santree's one notion of stacking
    // (git::BaseKind::LocalBranch), not a second nesting field.
    for (const choice of [
      { kind: "ticket", id: "AK-2", title: "Second", project: null },
      { kind: "existing", branch: "feature/sidebar" },
      { kind: "new", branch: "feature/child" },
    ] as const) {
      expect(createArgsFor(choice, "santree/ak-1-first").base).toBe("santree/ak-1-first");
    }
  });

  it("uses the repo default (no base) when there is no parent", () => {
    expect(createArgsFor({ kind: "new", branch: "solo" }, null).base).toBeNull();
  });
});
