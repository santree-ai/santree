import { beforeEach, describe, expect, it, vi } from "vitest";

import { commands } from "../../bindings";
import { TauriBackend } from "./TauriBackend";
import type { OpenOpts, OutputHandlers } from "./types";

/** Stand-in for Tauri's `Channel`: the backend only ever sets `onmessage` on it
 *  and hands it to `terminalOpen`/`terminalAttach`, so the test drives the PTY
 *  stream by calling that handler with raw `ArrayBuffer` chunks, exactly as Rust
 *  does. */
const { FakeChannel, channels } = vi.hoisted(() => {
  // biome-ignore lint/suspicious/noExplicitAny: a channel carries bytes or a link state.
  const channels: { onmessage?: (message: any) => void }[] = [];
  class FakeChannel {
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    onmessage?: (message: any) => void;
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

/** The channel Rust would be streaming into for the nth session opened. Each
 *  open or attach makes two, bytes first, then the link state. */
const stream = (n = 0) => channels[2 * n];
/** The nth session's link-state channel — only a session on Daedalus sends on it. */
const linkStream = (n = 0) => channels[2 * n + 1];
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

  /** A refused adoption in particular must not read as "nothing to adopt". */
  it("surfaces an open, attach or adopt failure as a thrown error", async () => {
    terminalOpen.mockResolvedValue({ status: "error", error: "no such cwd" });
    terminalAttach.mockResolvedValue({ status: "error", error: "no terminal session 7" });
    terminalAdopt.mockResolvedValue({ status: "error", error: "no server" });
    const backend = new TauriBackend();
    await expect(backend.open(opts, spyHandlers())).rejects.toThrow("no such cwd");
    await expect(backend.attach(7, { kind: "fresh" }, spyHandlers())).rejects.toThrow(
      "no terminal session 7",
    );
    await expect(backend.adoptSessions("page-2")).rejects.toThrow("no server");
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

  /** The sentinel is the last thing a session sends, and tearing a pane down
   *  twice would close a tab the user has since reopened. */
  it("treats an empty chunk as the exit, once, and never as output", async () => {
    const backend = new TauriBackend();
    const handlers = spyHandlers();
    await backend.open(opts, handlers);

    stream().onmessage?.(chunk(1));
    stream().onmessage?.(EXIT);
    stream().onmessage?.(EXIT);

    expect(handlers.out).toEqual([[1]]);
    expect(handlers.exits).toBe(1);
  });

  /** A session on Daedalus says whether its pane reaches it, on a channel of
   *  its own beside the bytes — never as bytes, and never as an exit. */
  it("hands a pane its link state, apart from its output", async () => {
    const backend = new TauriBackend();
    const links: string[] = [];
    const handlers = Object.assign(spyHandlers(), { onLink: (link: string) => links.push(link) });
    await backend.open(opts, handlers);

    linkStream().onmessage?.("reconnecting");
    stream().onmessage?.(chunk(1));
    linkStream().onmessage?.("live");

    expect(links).toEqual(["reconnecting", "live"]);
    expect(handlers.out).toEqual([[1]]);
    expect(handlers.exits).toBe(0);
  });

  it("attach catches a pane up on its own channel, then streams live", async () => {
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

  /** The tab an unvisited surface gets needs what the address alone can't say:
   *  where the session runs, and its provider (keying: `adoptedTabs.test.ts`). */
  it("hands adopted sessions over in full", async () => {
    const data = [
      { id: 3, label: "tree:a", agentKind: "Claude" as const, cwd: "/repo", command: "claude" },
    ];
    terminalAdopt.mockResolvedValue({ status: "ok", data });
    expect(await new TauriBackend().adoptSessions("page-2")).toEqual(data);
    expect(terminalAdopt).toHaveBeenCalledWith("page-2");
  });

  /** The two halves of the identity travel as two fields. The label is the
   *  `term_key` verbatim — it is joined byte-for-byte against the durable row,
   *  and a provider appended to it matched nothing, which is what made a live
   *  triage agent read as exited. A plain shell's provider is null, not invented. */
  it("passes the label and the provider through as separate fields", async () => {
    const backend = new TauriBackend();
    await backend.open({ ...opts, agentKind: "Codex" }, spyHandlers());
    await backend.open(opts, spyHandlers());
    expect(terminalOpen).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ label: "tree:a", agentKind: "Codex" }),
      expect.anything(),
      expect.anything(),
    );
    expect(terminalOpen).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ label: "tree:a", agentKind: null }),
      expect.anything(),
      expect.anything(),
    );
  });
});
