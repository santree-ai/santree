import { describe, expect, it } from "vitest";

import { splitRepoPath, splitRepoSlug } from "./repo";

describe("splitRepoSlug", () => {
  it("splits an owner/name slug", () => {
    expect(splitRepoSlug("acme/booking-agent")).toEqual(["acme", "booking-agent"]);
  });

  it("keeps extra slashes with the name", () => {
    expect(splitRepoSlug("acme/group/repo")).toEqual(["acme", "group/repo"]);
  });

  it("yields an empty name when there is no slash", () => {
    expect(splitRepoSlug("acme")).toEqual(["acme", ""]);
  });
});

describe("splitRepoPath", () => {
  it("splits on the last slash", () => {
    expect(splitRepoPath("canary-technologies-corp/canary")).toEqual({
      folder: "canary-technologies-corp",
      label: "canary",
    });
    expect(splitRepoPath("a/b/c")).toEqual({ folder: "a/b", label: "c" });
  });

  it("treats a name without a slash as its own folder", () => {
    expect(splitRepoPath("santree")).toEqual({ folder: "santree", label: "santree" });
  });
});
