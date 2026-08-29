import { beforeEach, describe, expect, it, vi } from "vitest";

import { commands } from "../../bindings";
import { TauriBackend } from "./TauriBackend";
import type { OpenOpts, OutputHandlers } from "./types";

/** Stand-in for Tauri's `Channel`: the backend only ever sets `onmessage` on it
 *  and hands it to `terminalOpen`/`terminalAttach`, so the test drives the PTY
 *  stream by calling that handler with raw `ArrayBuffer` chunks, exactly as Rust
 *  does. */
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
    terminalAttach: vi.fn(),
    terminalDetach: vi.fn(),
    terminalAdopt: vi.fn(),
    terminalWrite: vi.fn(),
    terminalResize: vi.fn(),
    terminalClose: vi.fn(),
  },
}));

const terminalOpen = vi.mocked(commands.terminalOpen);
const terminalAttach = vi.mocked(commands.terminalAttach);
const terminalAdopt = vi.mocked(commands.terminalAdopt);
const opts: OpenOpts = {
  cwd: "/repo",
  command: "",
  args: [],
  cols: 80,
  rows: 24,
  label: "tree:a",
};

/** The channel Rust would be streaming into for the nth session opened. */
const stream = (n = 0) => channels[n];
const chunk = (...bytes: number[]) => new Uint8Array(bytes).buffer;
const EXIT = new ArrayBuffer(0);

function spyHandlers(): OutputHandlers & { out: number[][]; exits: number } {
  const out: number[][] = [];
  let exits = 0;
  return {
    out,
    get exits() {
      return exits;
    },
    onOutput: (bytes) => out.push([...bytes]),
    onExit: () => {
      exits += 1;
    },
  };
}

describe("TauriBackend", () => {
  beforeEach(() => {
    channels.length = 0;
    vi.clearAllMocks();
    terminalOpen.mockResolvedValue({ status: "ok", data: 7 });
  });

  it("surfaces an open failure as a thrown error", async () => {
    terminalOpen.mockResolvedValue({ status: "error", error: "no such cwd" });
    await expect(new TauriBackend().open(opts, spyHandlers())).rejects.toThrow("no such cwd");
  });

  /** Handlers are supplied at open time rather than subscribed afterwards, so
   *  there is no window where bytes arrive with nobody to give them to — which
   *  is what the old pre-subscribe buffer existed to cover, without a bound. */
  it("delivers output from the first byte, with no buffering window", async () => {
    const backend = new TauriBackend();
    const handlers = spyHandlers();
    await backend.open(opts, handlers);

    stream().onmessage?.(chunk(104, 105));
    stream().onmessage?.(chunk(10));

    expect(handlers.out).toEqual([[104, 105], [10]]);
  });

  it("keeps each session's stream on its own handlers", async () => {
    const backend = new TauriBackend();
    const first = spyHandlers();
    const second = spyHandlers();
    await backend.open(opts, first);
    terminalOpen.mockResolvedValue({ status: "ok", data: 8 });
    await backend.open(opts, second);

    stream(0).onmessage?.(chunk(1));
    stream(1).onmessage?.(chunk(2));

    expect(first.out).toEqual([[1]]);
    expect(second.out).toEqual([[2]]);
  });

  describe("exit sentinel", () => {
    it("treats an empty chunk as the exit, and doesn't push it as output", async () => {
      const backend = new TauriBackend();
      const handlers = spyHandlers();
      await backend.open(opts, handlers);

      stream().onmessage?.(chunk(1));
      stream().onmessage?.(EXIT);

      expect(handlers.out).toEqual([[1]]);
      expect(handlers.exits).toBe(1);
    });

    /** The sentinel is the last thing a session sends, and tearing a pane down
     *  twice would close a tab the user has since reopened. */
    it("reports the exit at most once", async () => {
      const backend = new TauriBackend();
      const handlers = spyHandlers();
      await backend.open(opts, handlers);

      stream().onmessage?.(EXIT);
      stream().onmessage?.(EXIT);

      expect(handlers.exits).toBe(1);
    });
  });

  describe("attach", () => {
    it("catches a pane up on its own channel, then streams live", async () => {
      terminalAttach.mockResolvedValue({
        status: "ok",
        data: { epoch: "e1", seq: 12, mode: "tail" },
      });
      const backend = new TauriBackend();
      const handlers = spyHandlers();
      const attached = await backend.attach(7, { kind: "fresh" }, handlers);

      expect(attached).toEqual({ epoch: "e1", seq: 12, mode: "tail" });
      // Catch-up and live output arrive on the same channel, in order — which is
      // what makes the replay land before anything that follows it.
      stream().onmessage?.(chunk(99));
      expect(handlers.out).toEqual([[99]]);
    });

    it("passes a known position through to the backend", async () => {
      terminalAttach.mockResolvedValue({
        status: "ok",
        data: { epoch: "e1", seq: 40, mode: "exact" },
      });
      const backend = new TauriBackend();
      await backend.attach(7, { kind: "at", epoch: "e1", seq: 30 }, spyHandlers());

      expect(terminalAttach).toHaveBeenCalledWith(
        7,
        { kind: "at", epoch: "e1", seq: 30 },
        expect.anything(),
      );
    });

    it("surfaces an attach failure as a thrown error", async () => {
      terminalAttach.mockResolvedValue({ status: "error", error: "no terminal session 7" });
      const backend = new TauriBackend();
      await expect(backend.attach(7, { kind: "fresh" }, spyHandlers())).rejects.toThrow(
        "no terminal session 7",
      );
    });
  });

  describe("adopt", () => {
    /** Keyed by label, because that is what a pane coming up knows about
     *  itself — the same `term_key` its surface has always used. */
    it("returns inherited sessions keyed by label", async () => {
      terminalAdopt.mockResolvedValue({
        status: "ok",
        data: [
          { id: 3, label: "tree:a", cwd: "/repo", command: "/bin/zsh" },
          { id: 4, label: "tree:b", cwd: "/repo", command: "/bin/zsh" },
        ],
      });
      const adopted = await new TauriBackend().adopt("page-2");
      expect(adopted).toEqual(
        new Map([
          ["tree:a", 3],
          ["tree:b", 4],
        ]),
      );
    });

    it("is empty on a first load", async () => {
      terminalAdopt.mockResolvedValue({ status: "ok", data: [] });
      expect((await new TauriBackend().adopt("page-1")).size).toBe(0);
    });
  });

  it("passes the label through so a reloaded page can find the session", async () => {
    const backend = new TauriBackend();
    await backend.open(opts, spyHandlers());
    expect(terminalOpen).toHaveBeenCalledWith(
      expect.objectContaining({ label: "tree:a" }),
      expect.anything(),
    );
  });
});
