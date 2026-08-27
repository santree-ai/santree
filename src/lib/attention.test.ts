import { describe, expect, it } from "vitest";

import type { AgentBucket, AgentEntry } from "../features/agents/registry";
import {
  compareAttention,
  highest,
  IDLE,
  isUnseen,
  levelOf,
  needsYou,
  type SeenMap,
  seenKeyOf,
} from "./attention";

const NOW = 1_700_000_000_000;

function entry(over: Partial<AgentEntry> & { bucket: AgentBucket }): AgentEntry {
  return {
    sessionId: "s1",
    agentKind: "Claude",
    state: "active",
    origin: { kind: "tree", ticket: "AK-1", pr: null, path: null },
    repo: "acme/app",
    termKey: "tree:AK-1",
    cwd: "/repo",
    message: null,
    updatedAtMs: NOW,
    live: true,
    tabKey: null,
    openable: true,
    ticket: "AK-1",
    project: "Core",
    projectColor: null,
    projectIcon: null,
    purpose: "work",
    title: "Task",
    subtitle: null,
    worktree: null,
    ...over,
  } as AgentEntry;
}

describe("seenKeyOf", () => {
  it("follows the logical terminal, so a resumed session stays acknowledged", () => {
    expect(seenKeyOf(entry({ bucket: "working", sessionId: "new-session" }))).toBe("tree:AK-1");
  });

  it("falls back to the session for an agent no surface owns", () => {
    expect(seenKeyOf(entry({ bucket: "working", termKey: null }))).toBe("session:s1");
  });
});

describe("isUnseen", () => {
  const e = entry({ bucket: "done", updatedAtMs: NOW });

  it("is unseen when it moved after it was last looked at", () => {
    expect(isUnseen(e, { "tree:AK-1": NOW - 1000 })).toBe(true);
  });

  it("is seen once acknowledged at its own event time", () => {
    expect(isUnseen(e, { "tree:AK-1": NOW })).toBe(false);
  });

  it("treats a timestamp-less entry as seen rather than permanently bold", () => {
    expect(isUnseen(entry({ bucket: "done", updatedAtMs: null }), {})).toBe(false);
  });
});

describe("levelOf", () => {
  const fresh: SeenMap = {};
  const acknowledged: SeenMap = { "tree:AK-1": NOW };

  it("keeps a blocked agent urgent even after it has been looked at", () => {
    expect(levelOf(entry({ bucket: "attention" }), acknowledged).level).toBe("needs-you");
  });

  it("decays a finished agent to idle once seen", () => {
    expect(levelOf(entry({ bucket: "done" }), fresh).level).toBe("done");
    expect(levelOf(entry({ bucket: "done" }), acknowledged).level).toBe("idle");
  });

  it("reports work in progress without seen-gating it", () => {
    expect(levelOf(entry({ bucket: "working" }), acknowledged).level).toBe("working");
  });

  it("treats a detached session as at rest", () => {
    expect(levelOf(entry({ bucket: "detached" }), fresh).level).toBe("idle");
  });
});

describe("highest", () => {
  it("summarizes a row by its most urgent agent", () => {
    expect(
      highest([
        { level: "idle", at: NOW },
        { level: "working", at: NOW },
        { level: "needs-you", at: NOW - 5000 },
      ]).level,
    ).toBe("needs-you");
  });

  it("breaks a tie on the newest event, so the aggregate points at what just happened", () => {
    expect(
      highest([
        { level: "working", at: 10 },
        { level: "working", at: 90 },
      ]).at,
    ).toBe(90);
  });

  it("is idle when there is nothing to summarize", () => {
    expect(highest([])).toEqual(IDLE);
  });
});

describe("compareAttention", () => {
  it("orders by urgency first", () => {
    const rows = [
      { level: "idle" as const, at: NOW },
      { level: "working" as const, at: NOW },
      { level: "needs-you" as const, at: NOW },
      { level: "done" as const, at: NOW },
    ].sort(compareAttention);
    expect(rows.map((r) => r.level)).toEqual(["needs-you", "done", "working", "idle"]);
  });

  it("puts the most recent first within a level", () => {
    const rows = [
      { level: "working" as const, at: 10 },
      { level: "working" as const, at: 90 },
    ].sort(compareAttention);
    expect(rows[0]?.at).toBe(90);
  });
});

describe("needsYou", () => {
  it("counts only the level a human has to act on", () => {
    expect(needsYou("needs-you")).toBe(true);
    expect(needsYou("done")).toBe(false);
    expect(needsYou("working")).toBe(false);
  });
});
