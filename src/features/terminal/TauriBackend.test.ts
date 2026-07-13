import { beforeEach, describe, expect, it, vi } from "vitest";

import { commands } from "../../bindings";
import { TauriBackend } from "./TauriBackend";
import type { OpenOpts } from "./types";

/** Stand-in for Tauri's `Channel`: the backend only ever sets `onmessage` on it
 *  and hands it to `terminalOpen`, so the test drives the PTY stream by calling
 *  that handler with raw `ArrayBuffer` chunks, exactly as Rust does. */
const { FakeChannel, channels } = vi.hoisted(() => {
  const channels: { onmessage?: (chunk: ArrayBuffer) => void }[] = [];
  class FakeChannel {
    onmessage?: (chunk: ArrayBuffer) => void;
    constructor() {
      channels.push(this);
    }
  }
  return { FakeChannel, channels };
});

vi.mock("@tauri-apps/api/core", () => ({ Channel: FakeChannel }));
vi.mock("../../bindings", () => ({
  commands: {
    terminalOpen: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalClose: vi.fn(),
  },
}));

const terminalOpen = vi.mocked(commands.terminalOpen);
const opts: OpenOpts = { cwd: "/repo", command: "", args: [], cols: 80, rows: 24 };

/** The channel Rust would be streaming into for the nth session opened. */
const stream = (n = 0) => channels[n];
const chunk = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const EXIT = new ArrayBuffer(0);

describe("TauriBackend", () => {
  beforeEach(() => {
    channels.length = 0;
    vi.clearAllMocks();
    terminalOpen.mockResolvedValue({ status: "ok", data: 7 });
  });

  it("surfaces an open failure as a thrown error", async () => {
    terminalOpen.mockResolvedValue({ status: "error", error: "no such cwd" });
    await expect(new TauriBackend().open(opts)).rejects.toThrow("no such cwd");
  });

  describe("pre-subscribe buffering", () => {
    it("replays bytes that arrived before a subscriber attached, then streams live", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);

      // Rust starts streaming as soon as the PTY is up — before TerminalView has
      // wired the renderer to it.
      stream().onmessage?.(chunk(104, 105));
      stream().onmessage?.(chunk(10));

      const seen: Uint8Array[] = [];
      backend.onOutput(id, (b) => seen.push(b));
      expect(seen.map((b) => [...b])).toEqual([[104, 105], [10]]);

      stream().onmessage?.(chunk(33));
      expect(seen.map((b) => [...b])).toEqual([[104, 105], [10], [33]]);
    });

    it("drains the buffer on subscribe, so a later subscriber doesn't get the backlog twice", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);
      stream().onmessage?.(chunk(104));

      const first: Uint8Array[] = [];
      const unsub = backend.onOutput(id, (b) => first.push(b));
      expect(first).toHaveLength(1);
      unsub();

      const second: Uint8Array[] = [];
      backend.onOutput(id, (b) => second.push(b));
      expect(second).toHaveLength(0);
    });

    it("buffers again after an unsubscribe, so bytes between subscribers aren't lost", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);

      const first: Uint8Array[] = [];
      backend.onOutput(id, (b) => first.push(b))();
      stream().onmessage?.(chunk(120));
      expect(first).toHaveLength(0);

      const second: Uint8Array[] = [];
      backend.onOutput(id, (b) => second.push(b));
      expect(second.map((b) => [...b])).toEqual([[120]]);
    });

    it("keeps each session's stream on its own sink", async () => {
      const backend = new TauriBackend();
      const a = await backend.open(opts);
      terminalOpen.mockResolvedValue({ status: "ok", data: 8 });
      const b = await backend.open(opts);

      const seenA: number[] = [];
      const seenB: number[] = [];
      backend.onOutput(a, (bytes) => seenA.push(...bytes));
      backend.onOutput(b, (bytes) => seenB.push(...bytes));

      stream(0).onmessage?.(chunk(1));
      stream(1).onmessage?.(chunk(2));

      expect(seenA).toEqual([1]);
      expect(seenB).toEqual([2]);
    });
  });

  describe("exit sentinel", () => {
    it("treats an empty chunk as the exit, and doesn't push it to the output sink", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);
      const seen: Uint8Array[] = [];
      backend.onOutput(id, (b) => seen.push(b));
      const onExit = vi.fn();
      backend.onExit(id, onExit);

      stream().onmessage?.(EXIT);

      expect(onExit).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(0);
    });

    it("fires immediately when the process exited before onExit was registered", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);

      // A short-lived command can exit before the view finishes wiring up.
      stream().onmessage?.(EXIT);

      const onExit = vi.fn();
      const unsub = backend.onExit(id, onExit);
      expect(onExit).toHaveBeenCalledTimes(1);

      // The session is already gone; unsubscribing must be a harmless no-op.
      expect(() => unsub()).not.toThrow();
      stream().onmessage?.(EXIT);
      expect(onExit).toHaveBeenCalledTimes(1);
    });

    it("stops delivering the exit after unsubscribe", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);
      const onExit = vi.fn();
      backend.onExit(id, onExit)();

      stream().onmessage?.(EXIT);

      expect(onExit).not.toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("drops the sink, so subscribing to a closed session is inert", async () => {
      const backend = new TauriBackend();
      const id = await backend.open(opts);
      backend.close(id);
      expect(commands.terminalClose).toHaveBeenCalledWith(7);

      const onOutput = vi.fn();
      const onExit = vi.fn();
      backend.onOutput(id, onOutput);
      backend.onExit(id, onExit);

      // Bytes still in flight from Rust when we closed must go nowhere.
      stream().onmessage?.(chunk(104));
      stream().onmessage?.(EXIT);

      expect(onOutput).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    });
  });
});
