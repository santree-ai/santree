import { describe, expect, it } from "vitest";

import type { Worktree } from "../../bindings";
import { launchesToHost } from "./AgentRunHost";

function worktree(id: string, pending = false): Worktree {
  return {
    id,
    title: `Task ${id}`,
    status: null,
    addLines: 0,
    delLines: 0,
    dirty: false,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    remoteBehind: 0,
    pullConflict: false,
    agent: "Claude",
    activity: null,
    branch: pending ? "" : `santree/${id.toLowerCase()}`,
    path: pending ? "" : `/tmp/${id}`,
    project: null,
    baseBranch: "main",
    setupRan: false,
    pending,
  };
}

describe("launchesToHost", () => {
  const wts = [worktree("AK-1"), worktree("AK-2")];

  // The whole point of lifting this out of TreesProvider: a "Run in background"
  // launch from Issues never opens Trees, so nothing was mounted to run it. The
  // worktree got created and no agent ever started, while a toast said otherwise.
  it("hosts a queued launch when Trees is showing nothing (it isn't even mounted)", () => {
    expect(launchesToHost(new Set(["AK-1"]), wts, null).map((w) => w.id)).toEqual(["AK-1"]);
  });

  // …and the other half: a launch queued behind a setup run the user navigated away
  // from must still run. Trees unmounting releases `visibleWorktree`, so it lands here.
  it("hosts every queued launch except the one Trees currently has open", () => {
    const hosted = launchesToHost(new Set(["AK-1", "AK-2"]), wts, "AK-2");
    expect(hosted.map((w) => w.id)).toEqual(["AK-1"]);
  });

  // Two hosts for one refId would attach two xterm embeds to the same session and
  // fight over the single overlay.
  it("never hosts the worktree whose visible pane already owns that terminal", () => {
    expect(launchesToHost(new Set(["AK-1"]), wts, "AK-1")).toEqual([]);
  });

  it("waits for the real worktree — a placeholder has no path to root a terminal in", () => {
    const pending = [worktree("AK-3", true)];
    expect(launchesToHost(new Set(["AK-3"]), pending, null)).toEqual([]);
  });

  it("ignores a launch whose worktree is gone (deleted mid-launch)", () => {
    expect(launchesToHost(new Set(["AK-9"]), wts, null)).toEqual([]);
  });
});
