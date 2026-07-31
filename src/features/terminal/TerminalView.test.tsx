import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TerminalView } from "./TerminalView";
import type { OpenOpts, SessionId, TerminalBackend, TerminalRenderer } from "./types";

class FakeRenderer implements TerminalRenderer {
  mounted = false;
  disposed = false;
  written: (Uint8Array | string)[] = [];
  inputCb?: (data: string) => void;
  /** Mutable so a test can simulate the host being re-laid-out. */
  size = { cols: 100, rows: 30 };
  mount() {
    this.mounted = true;
  }
  write(d: Uint8Array | string) {
    this.written.push(d);
  }
  onInput(cb: (data: string) => void) {
    this.inputCb = cb;
  }
  reset() {
    this.written = [];
  }
  resize() {}
  fit() {
    return this.size;
  }
  focus() {}
  dispose() {
    this.disposed = true;
  }
}

/** jsdom has no ResizeObserver, so the component's observer branch is dead in tests
 *  unless we supply one we can fire on demand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(private cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  static fireAll() {
    for (const ro of FakeResizeObserver.instances) ro.cb();
  }
  static reset() {
    FakeResizeObserver.instances = [];
  }
}

class FakeBackend implements TerminalBackend {
  opened?: OpenOpts;
  outputCb?: (bytes: Uint8Array) => void;
  writes: Array<[SessionId, string]> = [];
  closed: SessionId[] = [];
  async open(opts: OpenOpts) {
    this.opened = opts;
    return 7 as SessionId;
  }
  onOutput(_id: SessionId, cb: (bytes: Uint8Array) => void) {
    this.outputCb = cb;
    return () => {
      this.outputCb = undefined;
    };
  }
  exitCb?: () => void;
  onExit(_id: SessionId, cb: () => void) {
    this.exitCb = cb;
    return () => {
      this.exitCb = undefined;
    };
  }
  write(id: SessionId, data: string) {
    this.writes.push([id, data]);
  }
  resized: Array<[number, number]> = [];
  resize(_id: SessionId, cols: number, rows: number) {
    this.resized.push([cols, rows]);
  }
  close(id: SessionId) {
    this.closed.push(id);
  }
}

test("TerminalView wires the renderer to the backend and cleans up", async () => {
  const renderer = new FakeRenderer();
  const backend = new FakeBackend();

  const { unmount } = render(
    <TerminalView
      cwd="/tmp"
      command=""
      seed="echo hi"
      backend={backend}
      createRenderer={() => renderer}
    />,
  );

  // Opens a session sized to the fitted grid, in the given cwd.
  await waitFor(() => expect(backend.opened).toBeTruthy());
  expect(renderer.mounted).toBe(true);
  expect(backend.opened).toMatchObject({ cwd: "/tmp", command: "", cols: 100, rows: 30 });

  // Seed is sent as if typed (with a trailing Enter).
  await waitFor(() => expect(backend.writes).toContainEqual([7, "echo hi\r"]));

  // PTY output → renderer.
  backend.outputCb?.(new Uint8Array([104, 105]));
  expect(renderer.written.length).toBeGreaterThan(0);

  // Keystrokes → PTY.
  renderer.inputCb?.("x");
  expect(backend.writes).toContainEqual([7, "x"]);

  // Unmount tears the session and renderer down.
  unmount();
  expect(backend.closed).toContain(7);
  expect(renderer.disposed).toBe(true);
});

describe("resize", () => {
  afterEach(() => {
    FakeResizeObserver.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Every pane stays laid out at the shared layer's full size, so ANY layer geometry
  // change (opening an embed, collapsing the sidebar) resizes all of them at once.
  // Only the pane on screen may forward that to its PTY — a SIGWINCH to a backgrounded
  // shell makes it reprint its prompt, and those blank lines accumulate unseen.
  test("a hidden pane ignores a layer resize; the visible one forwards it", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();

    const { rerender } = render(
      <TerminalView active={false} backend={backend} createRenderer={() => renderer} />,
    );
    await waitFor(() => expect(backend.opened).toBeTruthy());
    vi.useFakeTimers();

    // The layer was re-laid-out: the host is now a different grid.
    renderer.size = { cols: 80, rows: 24 };
    act(() => {
      FakeResizeObserver.fireAll();
      vi.advanceTimersByTime(200);
    });
    expect(backend.resized).toEqual([]);

    // Same event, but this pane is the one on screen.
    rerender(<TerminalView active backend={backend} createRenderer={() => renderer} />);
    act(() => {
      FakeResizeObserver.fireAll();
      vi.advanceTimersByTime(200);
    });
    expect(backend.resized).toEqual([[80, 24]]);
  });
});

// The pane can be closed while `backend.open` is still in flight. The failure path
// used to write an error banner to a renderer that had already been disposed, which
// throws — as an unhandled rejection, from inside a fire-and-forget async IIFE.
test("an open that fails after the pane closed does not write to the disposed renderer", async () => {
  const renderer = new FakeRenderer();
  const backend = new FakeBackend();
  let fail: (e: Error) => void = () => {};
  backend.open = () =>
    new Promise<SessionId>((_, reject) => {
      fail = reject;
    });

  const { unmount } = render(<TerminalView backend={backend} createRenderer={() => renderer} />);
  unmount();
  expect(renderer.disposed).toBe(true);

  await act(async () => {
    fail(new Error("no such cwd"));
  });

  expect(renderer.written).toEqual([]);
});
