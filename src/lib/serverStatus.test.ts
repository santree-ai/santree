import { describe, expect, it } from "vitest";

import type { ServerState } from "../bindings";
import {
  endDrainingConfirm,
  formatUptime,
  restartConfirm,
  serverStateView,
  sessionCountText,
  stopConfirm,
} from "./serverStatus";

describe("serverStatus words", () => {
  it("never draws an unknown count as zero", () => {
    expect(sessionCountText({ kind: "Unknown" })).toBe("an unknown number of sessions");
    expect(sessionCountText({ kind: "Known", count: 0 })).toBe("0 sessions");
    expect(sessionCountText({ kind: "Known", count: 1 })).toBe("1 session");
    expect(endDrainingConfirm(2, { kind: "Unknown" })).toContain("an unknown number of sessions");
    expect(endDrainingConfirm(2, { kind: "Unknown" })).not.toContain("0 sessions");
  });

  it("names the count and says agents can be resumed", () => {
    for (const text of [
      restartConfirm({ kind: "Known", count: 3 }),
      stopConfirm({ kind: "Known", count: 3 }),
      endDrainingConfirm(2, { kind: "Known", count: 3 }),
    ]) {
      expect(text).toContain("3 sessions");
      expect(text).toContain("resumed from their tabs");
    }
    expect(stopConfirm({ kind: "Known", count: 1 })).toContain("Nothing starts it again");
  });

  it("says nothing ends when it is a known zero", () => {
    expect(restartConfirm({ kind: "Known", count: 0 })).toContain("nothing else will end");
  });

  it("formats uptime", () => {
    expect(formatUptime(42_000)).toBe("<1m");
    expect(formatUptime(5 * 60_000)).toBe("5m");
    expect(formatUptime((3 * 60 + 12) * 60_000)).toBe("3h 12m");
    expect(formatUptime((52 * 60 + 5) * 60_000 + 1)).toBe("2d 4h");
    expect(formatUptime(-5)).toBe("<1m");
  });
});

describe("serverStateView", () => {
  const states: ServerState[] = [
    { kind: "Off" },
    { kind: "Starting" },
    { kind: "Stopping" },
    {
      kind: "Running",
      revision: 1,
      version: "v",
      pid: 1,
      startedAtMs: 0,
      liveSessions: 0,
    },
    { kind: "Down", reason: "Stopped." },
    { kind: "Failing", reason: "Crashed." },
  ];

  it("blocks a resume exactly when the server cannot take a new session", () => {
    const blocked = states.filter((s) => serverStateView(s).blocksResume).map((s) => s.kind);
    expect(blocked).toEqual(["Starting", "Stopping", "Down", "Failing"]);
  });

  it("speaks at once for trouble, after a wait for a start or a stop, and never otherwise", () => {
    expect(states.map((s) => [s.kind, serverStateView(s).attention])).toEqual([
      ["Off", "never"],
      ["Starting", "held"],
      ["Stopping", "held"],
      ["Running", "never"],
      ["Down", "now"],
      ["Failing", "now"],
    ]);
  });

  it("says Stopping, not Starting, while a stop runs", () => {
    const view = serverStateView({ kind: "Stopping" });
    expect(view.title).toBe("Stopping…");
    expect(view.short).toBe("server stopping…");
  });
});
