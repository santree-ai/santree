import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentEntry as entry, NOW, STALE } from "../test/fixtures";
import {
  compareAttention,
  HOOK_STALE_AFTER_MS,
  highest,
  isUnseen,
  levelOf,
  nextDecayAt,
  type SeenMap,
  seenKeyOf,
  useDecayClock,
} from "./attention";

describe("seenKeyOf", () => {
  it("follows the logical terminal, so a resumed session stays acknowledged", () => {
    expect(seenKeyOf(entry({ bucket: "working", sessionId: "new-session" }))).toBe("tree:AK-1");
  });

  it("falls back to the session for an agent no surface owns", () => {
    expect(seenKeyOf(entry({ bucket: "working", termKey: null }))).toBe("session:s1");
  });
});

describe("isUnseen", () => {
  it("is unseen only when it moved after it was last looked at", () => {
    const e = entry({ bucket: "done", updatedAtMs: NOW });
    expect(isUnseen(e, { "tree:AK-1": NOW - 1000 })).toBe(true);
    expect(isUnseen(e, { "tree:AK-1": NOW })).toBe(false);
    // A timestamp-less entry reads as seen rather than permanently bold.
    expect(isUnseen(entry({ bucket: "done", updatedAtMs: null }), {})).toBe(false);
  });
});

describe("levelOf", () => {
  const fresh: SeenMap = {};
  const acknowledged: SeenMap = { "tree:AK-1": NOW };

  it("keeps a blocked agent urgent even after it has been looked at", () => {
    expect(levelOf(entry({ bucket: "attention" }), acknowledged, NOW).level).toBe("needs-you");
  });

  it("decays a finished agent to idle once seen", () => {
    expect(levelOf(entry({ bucket: "done" }), fresh, NOW).level).toBe("done");
    expect(levelOf(entry({ bucket: "done" }), acknowledged, NOW).level).toBe("idle");
  });
});

/**
 * The three-tier arbitration: a fresh hook event, else the terminal title of a
 * live PTY, else nothing. The tiers exist because santree's agent state is
 * entirely hook-driven — when an event is dropped, the row asserts its last
 * reading forever, and "Idle" sits beside an agent that is visibly working.
 */
describe("levelOf tiers", () => {
  const seen: SeenMap = {};

  it("lets a fresh hook event win over a title that contradicts it", () => {
    // The hook sits inside the agent's own lifecycle; a title is an artifact of
    // whatever the CLI last painted. While the event is recent it is the answer.
    const idleHookWorkingTitle = entry({
      bucket: "idle",
      updatedAtMs: NOW,
      terminalTitle: "◐ Fix the flaky suite",
    });
    expect(levelOf(idleHookWorkingTitle, seen, NOW)).toMatchObject({
      level: "idle",
      source: "hook",
    });

    const workingHookIdleTitle = entry({
      bucket: "working",
      updatedAtMs: NOW,
      terminalTitle: "✳ Claude Code",
    });
    expect(levelOf(workingHookIdleTitle, seen, NOW)).toMatchObject({
      level: "working",
      source: "hook",
    });
  });

  it("falls back to the title once the hook event is older than the window", () => {
    // The bug this fixes: `Stop` landed, the next `UserPromptSubmit` never did,
    // and the row has read idle for an hour while the agent kept working.
    const stale = entry({
      bucket: "idle",
      updatedAtMs: STALE,
      terminalTitle: "◐ Fix the flaky suite",
    });
    expect(levelOf(stale, seen, NOW)).toMatchObject({ level: "working", source: "title" });
  });

  it("decays a stale non-terminal hook state to idle, leaving the row untouched", () => {
    const stale = entry({ bucket: "working", state: "active", updatedAtMs: STALE });
    expect(levelOf(stale, seen, NOW)).toMatchObject({ level: "idle", source: "none" });
    // Display-only: the record of what the hook said is not rewritten to agree,
    // and the same entry read a millisecond earlier still resolves the old way.
    expect(stale.state).toBe("active");
    expect(stale.bucket).toBe("working");
    expect(stale.updatedAtMs).toBe(STALE);
    expect(levelOf(stale, seen, STALE + HOOK_STALE_AFTER_MS).level).toBe("working");
  });

  it("decays a stale block, so a dead prompt stops shouting", () => {
    const stale = entry({ bucket: "attention", updatedAtMs: STALE });
    expect(levelOf(stale, seen, NOW).level).toBe("idle");
    expect(levelOf(entry({ bucket: "attention", updatedAtMs: NOW }), seen, NOW).level).toBe(
      "needs-you",
    );
  });

  it("never expires a finished session, however long ago it finished", () => {
    // `done` is terminal: the process is gone, so no later evidence can exist,
    // and the seen-gating is the only thing that moves it.
    const old = entry({ bucket: "done", updatedAtMs: STALE });
    expect(levelOf(old, seen, NOW)).toMatchObject({ level: "done", source: "hook" });
  });

  it("takes nothing from the title of a session with no live PTY", () => {
    // A title from a dead process is a ghost — it says "working" forever.
    const ghost = entry({
      bucket: "detached",
      live: false,
      updatedAtMs: STALE,
      terminalTitle: "◐ Fix the flaky suite",
    });
    expect(levelOf(ghost, seen, NOW)).toMatchObject({ level: "idle", source: "none" });
  });

  it("treats a row that cannot say when it changed as not fresh", () => {
    // A timestamp is what makes a claim checkable. Without one the row asserts
    // "working" with nothing to date it, so the live title answers instead.
    const undated = entry({ bucket: "working", updatedAtMs: null });
    expect(levelOf(undated, seen, NOW)).toMatchObject({ level: "idle", source: "none" });
    expect(levelOf({ ...undated, terminalTitle: "\u25d0 still going" }, seen, NOW)).toMatchObject({
      level: "working",
      source: "title",
    });
  });

  it("keeps the hook event's timestamp whichever tier answers", () => {
    // Ordering ties break on `at`, and a title tells you nothing about when the
    // agent last did something — only that it is doing something now.
    const stale = entry({ bucket: "idle", updatedAtMs: STALE, terminalTitle: "◐ working" });
    expect(levelOf(stale, seen, NOW).at).toBe(STALE);
  });
});

describe("nextDecayAt", () => {
  it("ignores deadlines that have already passed — they need no timer", () => {
    const entries = [
      entry({ bucket: "working", updatedAtMs: NOW - HOOK_STALE_AFTER_MS - 1 }),
      entry({ bucket: "working", updatedAtMs: NOW }),
    ];
    expect(nextDecayAt(entries, NOW)).toBe(NOW + HOOK_STALE_AFTER_MS);
  });
});

describe("useDecayClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules one timer for the whole tree, at the earliest expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const entries = [
      entry({ bucket: "working", updatedAtMs: NOW - 5 * 60_000 }),
      entry({ bucket: "working", updatedAtMs: NOW - 20 * 60_000 }),
      entry({ bucket: "attention", updatedAtMs: NOW - 60_000 }),
    ];

    renderHook(() => useDecayClock(entries));

    // One timer for three rows, and it is armed at the *first* expiry — a timer
    // per entry would wake twice more before anything could change.
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0][1]).toBe(HOOK_STALE_AFTER_MS - 20 * 60_000);
  });

  it("advances the clock when a deadline passes, then arms for the next", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const entries = [
      entry({ bucket: "working", updatedAtMs: NOW - 20 * 60_000 }),
      entry({ bucket: "working", updatedAtMs: NOW - 5 * 60_000 }),
    ];
    const { result } = renderHook(() => useDecayClock(entries));
    expect(result.current).toBe(NOW);

    act(() => {
      vi.advanceTimersByTime(HOOK_STALE_AFTER_MS - 20 * 60_000);
    });
    expect(result.current).toBe(NOW + HOOK_STALE_AFTER_MS - 20 * 60_000);

    act(() => {
      vi.advanceTimersByTime(15 * 60_000);
    });
    expect(result.current).toBe(NOW + HOOK_STALE_AFTER_MS - 5 * 60_000);
  });

  it("arms nothing when no row can decay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    renderHook(() => useDecayClock([entry({ bucket: "done", updatedAtMs: NOW })]));
    expect(timeout).not.toHaveBeenCalled();
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
