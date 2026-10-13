import { describe, expect, it } from "vitest";

import {
  connectionProvider,
  ticketHandle,
  tickTickTaskUrl,
  trackerFeatures,
  trackerOf,
} from "./tracker";

describe("trackerOf", () => {
  it("names Jira or TickTick only when the detail says so, and reads no name as Linear's", () => {
    expect(trackerOf("Jira")).toBe("Jira");
    expect(trackerOf("TickTick")).toBe("TickTick");
    expect(trackerOf("Linear")).toBe("Linear");
    expect(trackerOf(undefined)).toBe("Linear");
    expect(trackerOf(null)).toBe("Linear");
  });
});

describe("trackerFeatures", () => {
  it("gives a Linear org connected through OAuth everything", () => {
    expect(trackerFeatures("Linear", "OAuth")).toEqual({
      triage: true,
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

/** A TickTick id is shown as its handle and linked by its two halves; the
 *  shape must match `ticktick::split_id`, or a branch slug would pass for one. */
describe("TickTick ids", () => {
  const id = "6226ff9877acee87727f6bca.6247ee29630c800F064FD145";
  it.each([
    [
      id,
      "tt-4fd145",
      "https://ticktick.com/webapp/#p/6226ff9877acee87727f6bca/tasks/6247ee29630c800F064FD145",
    ],
    [
      "inbox114478622.63b7bebb91c0a5474805fcd4",
      "tt-05fcd4",
      "https://ticktick.com/webapp/#p/inbox114478622/tasks/63b7bebb91c0a5474805fcd4",
    ],
    ["ENG-142", "ENG-142", null],
    ["v1.2.3", "v1.2.3", null],
    ["a/b.c", "a/b.c", null],
    [".abc", ".abc", null],
  ])("%s reads as %s", (raw, handle, url) => {
    expect(ticketHandle(raw)).toBe(handle);
    expect(tickTickTaskUrl(raw)).toBe(url);
  });

  it("knows the TickTick connection and its features", () => {
    expect(connectionProvider("ticktick:me")).toBe("TickTick");
    expect(trackerFeatures("TickTick", null)).toMatchObject({
      triage: false,
      threadedComments: false,
    });
  });
});
