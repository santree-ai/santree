import { describe, expect, it } from "vitest";

import { splitRepoPath, splitRepoSlug } from "./repo";

describe("splitRepoSlug", () => {
  it("splits at the first slash, keeping extra slashes with the name", () => {
    expect(splitRepoSlug("acme/booking-agent")).toEqual(["acme", "booking-agent"]);
    expect(splitRepoSlug("acme/group/repo")).toEqual(["acme", "group/repo"]);
    expect(splitRepoSlug("acme")).toEqual(["acme", ""]);
  });
});

describe("splitRepoPath", () => {
  it("splits on the last slash, and treats a bare name as its own folder", () => {
    expect(splitRepoPath("a/b/c")).toEqual({ folder: "a/b", label: "c" });
    expect(splitRepoPath("santree")).toEqual({ folder: "santree", label: "santree" });
  });
});
