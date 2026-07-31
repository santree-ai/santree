import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "../bindings";
import {
  type EventSink,
  getRun,
  MAX_CHARS,
  markStopped,
  resetAll,
  startRun,
  trim,
} from "./streamRuns";

/** A stand-in for the Tauri Channel: hands the test the sink the store wired up. */
function fakeChannel() {
  const sink: EventSink = { onmessage: () => {} };
  return { sink, make: () => sink };
}

const ok = async () => ({ status: "ok" });

beforeEach(resetAll);

describe("startRun", () => {
  it("collects chunks in order and settles on done", () => {
    const ch = fakeChannel();
    const settled = vi.fn();
    startRun("k", ch.make, ok, 1000, settled);

    expect(getRun("k").running).toBe(true);
    ch.sink.onmessage({ type: "chunk", text: "a" } as StreamEvent);
    ch.sink.onmessage({ type: "chunk", text: "\x1b[32mb\x1b[0m" } as StreamEvent);
    expect(getRun("k").chunks).toEqual(["a", "\x1b[32mb\x1b[0m"]);
    expect(settled).not.toHaveBeenCalled();

    ch.sink.onmessage({ type: "done", ok: true } as StreamEvent);
    expect(getRun("k")).toMatchObject({ running: false, ok: true, startedMs: 1000 });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  // "Sticks until you build again": the transcript of a finished run stays put, and
  // starting the next one replaces it wholesale rather than appending to it.
  it("keeps a finished run's output, and clears it only when the next run starts", () => {
    const first = fakeChannel();
    startRun("k", first.make, ok, 1);
    first.sink.onmessage({ type: "chunk", text: "old" } as StreamEvent);
    first.sink.onmessage({ type: "done", ok: false } as StreamEvent);
    expect(getRun("k").chunks).toEqual(["old"]);

    const second = fakeChannel();
    startRun("k", second.make, ok, 2);
    const run = getRun("k");
    expect(run.chunks).toEqual([]);
    expect(run.ok).toBeNull();
    expect(run.gen).toBeGreaterThan(1);
  });

  // Stop settles the run here immediately, but the kill reaches the process
  // asynchronously — so a cancelled command's reader can still emit after the *next*
  // run has begun. Those bytes belong to a transcript that's already been replaced,
  // and a stale `done` would wrongly report the new run as finished.
  it("ignores events from a superseded run", () => {
    const first = fakeChannel();
    startRun("k", first.make, ok, 1);
    markStopped("k");
    const second = fakeChannel();
    startRun("k", second.make, ok, 2);

    first.sink.onmessage({ type: "chunk", text: "straggler" } as StreamEvent);
    first.sink.onmessage({ type: "done", ok: true } as StreamEvent);

    expect(getRun("k").chunks).toEqual([]);
    expect(getRun("k").running).toBe(true);
  });

  it("refuses to start a second run while one is in flight", () => {
    const invoke = vi.fn(ok);
    startRun("k", fakeChannel().make, invoke, 1);
    startRun("k", fakeChannel().make, invoke, 2);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("surfaces a command that never started as a failed run", async () => {
    const settled = vi.fn();
    startRun(
      "k",
      fakeChannel().make,
      async () => ({ status: "error", error: "no such checkout" }),
      1,
      settled,
    );
    await vi.waitFor(() => expect(getRun("k").running).toBe(false));
    expect(getRun("k").ok).toBe(false);
    expect(getRun("k").chunks.join("")).toContain("no such checkout");
    expect(settled).toHaveBeenCalledTimes(1);
  });

  // The view writes chunks incrementally, tracking how many it has already sent. A
  // trim invalidates that cursor, so it has to be told to start over — otherwise it
  // would silently skip however many chunks were dropped.
  it("bumps the generation when the buffer is trimmed, but not on a plain append", () => {
    const ch = fakeChannel();
    startRun("k", ch.make, ok, 1);
    ch.sink.onmessage({ type: "chunk", text: "x" } as StreamEvent);
    const before = getRun("k").gen;

    ch.sink.onmessage({ type: "chunk", text: "y" } as StreamEvent);
    expect(getRun("k").gen).toBe(before);

    ch.sink.onmessage({ type: "chunk", text: "z".repeat(MAX_CHARS + 1) } as StreamEvent);
    expect(getRun("k").gen).toBeGreaterThan(before);
  });
});

describe("trim", () => {
  it("returns the same array when the buffer is under the cap", () => {
    const chunks = ["a", "b"];
    expect(trim(chunks)).toBe(chunks);
  });

  it("drops the oldest chunks until it fits, keeping the newest", () => {
    const chunks = ["x".repeat(MAX_CHARS), "old", "new"];
    const out = trim(chunks);
    expect(out).not.toContain("x".repeat(MAX_CHARS));
    expect(out.at(-1)).toBe("new");
  });
});
