import { describe, expect, it } from "vitest";

import { repoSessionRefId } from "./RepoSessionPane";

describe("repoSessionRefId", () => {
  // The terminal registry dedups on (source, refId) alone — no cwd, no repo — so
  // a shared sentinel would hand the second repo's session the first repo's live
  // PTY, still running in the first repo's directory. Per-ticket panes are safe
  // by accident (Linear ids are globally unique); this one has to be explicit.
  it("is distinct per repo", () => {
    expect(repoSessionRefId("acme/app")).not.toBe(repoSessionRefId("acme/infra"));
  });

  it("is stable for one repo, so reopening reattaches instead of spawning a second PTY", () => {
    expect(repoSessionRefId("acme/app")).toBe(repoSessionRefId("acme/app"));
  });

  // `__` never appears in a Linear issue id, so the sentinel can't be mistaken
  // for — or collide with — a real ticket's pane.
  it("can't be confused with a ticket id", () => {
    expect(repoSessionRefId("acme/app")).toContain("__");
    expect(repoSessionRefId("acme/app")).not.toMatch(/^[A-Z]+-\d+$/);
  });
});
