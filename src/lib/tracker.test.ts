import { describe, expect, it } from "vitest";

import { trackerFeatures, trackerOf } from "./tracker";

describe("trackerOf", () => {
  it("names Jira only when the detail says so", () => {
    expect(trackerOf("Jira")).toBe("Jira");
    expect(trackerOf("Linear")).toBe("Linear");
  });

  it("reads a detail with no tracker name as Linear's", () => {
    expect(trackerOf(undefined)).toBe("Linear");
    expect(trackerOf(null)).toBe("Linear");
  });
});

describe("trackerFeatures", () => {
  it("gives a Linear org connected through OAuth everything", () => {
    expect(trackerFeatures("Linear", "OAuth")).toEqual({
      snoozeUnavailable: null,
      threadedComments: true,
      memberTeamsOnly: false,
    });
  });

  /** Before the status read lands there is no connection to go by: read it as
   *  OAuth, so nothing flickers disabled while an ordinary install launches. */
  it("reads a Linear repo whose connection isn't known yet as OAuth", () => {
    expect(trackerFeatures("Linear", undefined)).toEqual(trackerFeatures("Linear", "OAuth"));
    expect(trackerFeatures("Linear", null)).toEqual(trackerFeatures("Linear", "OAuth"));
  });

  it("takes snooze away from an MCP-connected org, says why, and narrows triage", () => {
    const mcp = trackerFeatures("Linear", "Mcp");
    expect(mcp.snoozeUnavailable).toMatch(/MCP server can't snooze/);
    expect(mcp.threadedComments).toBe(true);
    expect(mcp.memberTeamsOnly).toBe(true);
  });

  it("has Jira say snooze is unavailable and offer no threads, whatever Linear says", () => {
    for (const via of ["OAuth", "Mcp", null] as const) {
      const jira = trackerFeatures("Jira", via);
      expect(jira.snoozeUnavailable).toMatch(/Jira/);
      expect(jira.threadedComments).toBe(false);
      expect(jira.memberTeamsOnly).toBe(false);
    }
  });
});
