import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resetSessionTitles, sessionTitles } from "./sessionTitles";
import { TerminalView } from "./TerminalView";
import type {
  Anchor,
  Attached,
  OpenOpts,
  OutputHandlers,
  SessionId,
  TerminalBackend,
  TerminalRenderer,
} from "./types";

class FakeRenderer implements TerminalRenderer {
  mounted = false;
  disposed = false;
  written: (Uint8Array | string)[] = [];
  inputCb?: (data: string) => void;
  /** How the tests play a program setting its OSC window title. */
  titleCb?: (title: string) => void;
  /** Mutable so a test can simulate the host being re-laid-out. */
  size = { cols: 100, rows: 30 };
  /** How many times the grid was re-fitted to the element (see the resize tests:
   *  fitting is immediate, only the PTY resize waits for the size to settle). */
  fits = 0;
  mount() {
    this.mounted = true;
  }
  write(d: Uint8Array | string) {
    this.written.push(d);
  }
  onInput(cb: (data: string) => void) {
    this.inputCb = cb;
  }
  onTitle(cb: (title: string) => void) {
    this.titleCb = cb;
  }
  reset() {
    this.written = [];
  }
  resize() {}
  fit() {
    this.fits += 1;
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
  handlers?: OutputHandlers;
  writes: Array<[SessionId, string]> = [];
  /** Seeds are recorded apart from keystrokes because the backend treats them
   *  differently — see `terminal_seed` in `terminal.rs`. */
  seeded: Array<[SessionId, string]> = [];
  closed: SessionId[] = [];
  detached: SessionId[] = [];
  attaches: Array<[SessionId, Anchor]> = [];
  attachResult: Attached = { epoch: "e1", seq: 12, mode: "tail" };
  opens = 0;
  async open(opts: OpenOpts, handlers: OutputHandlers) {
    this.opened = opts;
    this.handlers = handlers;
    this.opens += 1;
    return 7 as SessionId;
  }
  async attach(id: SessionId, anchor: Anchor, handlers: OutputHandlers) {
    this.attaches.push([id, anchor]);
    this.handlers = handlers;
    return this.attachResult;
  }
  detach(id: SessionId) {
    this.detached.push(id);
  }
  async adopt() {
    return new Map<string, SessionId>();
  }
  write(id: SessionId, data: string) {
    this.writes.push([id, data]);
  }
  seed(id: SessionId, seed: string) {
    this.seeded.push([id, seed]);
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
      label="tree:a"
      seed="echo hi"
      backend={backend}
      createRenderer={() => renderer}
    />,
  );

  // Opens a session sized to the fitted grid, in the given cwd.
  await waitFor(() => expect(backend.opened).toBeTruthy());
  expect(renderer.mounted).toBe(true);
  expect(backend.opened).toMatchObject({ cwd: "/tmp", command: "", cols: 100, rows: 30 });

  // The seed goes out on the seed channel, not as keystrokes: the backend adds
  // the Enter and decides whether the line can be typed at all (see below).
  await waitFor(() => expect(backend.seeded).toContainEqual([7, "echo hi"]));
  expect(backend.writes).toEqual([]);

  // PTY output → renderer.
  backend.handlers?.onOutput(new Uint8Array([104, 105]));
  expect(renderer.written.length).toBeGreaterThan(0);

  // Keystrokes → PTY.
  renderer.inputCb?.("x");
  expect(backend.writes).toContainEqual([7, "x"]);

  // Unmount releases the pane but NOT the session: a pane going away says
  // nothing about whether the work in it should stop.
  unmount();
  expect(backend.detached).toContain(7);
  expect(backend.closed).toEqual([]);
  expect(renderer.disposed).toBe(true);
});

/** The launch line is the one thing santree types on the user's behalf, and it
 *  is the one thing that may have to be reshaped before it can be typed at all:
 *  a tty in canonical mode drops everything past ~1KB of a line without a word,
 *  which is how a Codex launch (an `env` prefix, six `-c 'hooks.…'` flags, and
 *  two absolute paths repeated in each) came to sit half-typed at the prompt.
 *  Keeping that decision behind `seed()` is what lets the backend make it — and
 *  what keeps it away from `write()`, where a long paste must stay verbatim. */
test("hands the launch line to the backend's seed channel however long it is", async () => {
  const renderer = new FakeRenderer();
  const backend = new FakeBackend();
  const long = `exec env SANTREE_TERM_KEY='tree:AK-1' '/opt/homebrew/bin/codex' ${"-c 'hooks.X=[]' ".repeat(200)}`;

  render(
    <TerminalView
      label="tree:AK-1"
      command=""
      seed={long}
      backend={backend}
      createRenderer={() => renderer}
    />,
  );

  await waitFor(() => expect(backend.seeded.length).toBe(1));
  // Untouched on the way out: the frontend neither shortens it nor splits it.
  // Whether it can be typed as one line is the backend's call.
  expect(backend.seeded[0]).toEqual([7, long]);
  expect(backend.writes).toEqual([]);
});

describe("terminal title", () => {
  /** The OSC title is a read-only status signal: a coding CLI animates it while
   *  it works, and the sidebar falls back to it when hook events go quiet. It
   *  never travels the other way — see `agentTitle.ts`. */
  test("files a pane's title under its label, and clears it when the pane goes", async () => {
    resetSessionTitles();
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();

    const { unmount } = render(
      <TerminalView
        cwd="/tmp"
        command="claude"
        label="tree:AK-1"
        backend={backend}
        createRenderer={() => renderer}
      />,
    );

    await waitFor(() => expect(backend.opened).toBeTruthy());
    act(() => renderer.titleCb?.("\u25d0 Fix the flaky suite"));
    expect(sessionTitles().get("tree:AK-1")).toBe("\u25d0 Fix the flaky suite");

    // Nothing is left pointing at a process that has gone: a title that outlived
    // its PTY would report "working" with nothing able to correct it.
    unmount();
    expect(sessionTitles().has("tree:AK-1")).toBe(false);
  });
});

describe("adoption", () => {
  /** A session inherited from the previous page load is already running the
   *  thing its command names — re-running it would spawn a second agent. */
  test("attaches to an inherited session instead of spawning, and skips the seed", async () => {
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();

    render(
      <TerminalView
        cwd="/tmp"
        command="claude"
        label="tree:a"
        adoptId={42}
        seed="echo hi"
        backend={backend}
        createRenderer={() => renderer}
      />,
    );

    await waitFor(() => expect(backend.attaches.length).toBe(1));
    expect(backend.opened).toBeUndefined();
    // `fresh`, not `unknown`: this xterm was just built, so a full replay
    // cannot duplicate anything already on it.
    expect(backend.attaches[0]).toEqual([42, { kind: "fresh" }]);
    expect(backend.writes).toEqual([]);
    expect(backend.seeded).toEqual([]);
  });

  /** Keystrokes and output have to reach the adopted session, not a phantom. */
  test("wires input and output to the adopted session's id", async () => {
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();

    render(
      <TerminalView
        label="tree:a"
        adoptId={42}
        backend={backend}
        createRenderer={() => renderer}
      />,
    );
    await waitFor(() => expect(backend.attaches.length).toBe(1));

    backend.handlers?.onOutput(new Uint8Array([104]));
    expect(renderer.written.length).toBeGreaterThan(0);

    renderer.inputCb?.("x");
    expect(backend.writes).toContainEqual([42, "x"]);
  });

  /** React re-runs an effect without unmounting — StrictMode does it on every
   *  mount in development. Since cleanup only detaches, a second run that opened
   *  again would strand the first session with nothing pointing at it: a live
   *  shell, invisible, for the life of the app. */
  test("an effect that re-runs re-attaches instead of opening a second session", async () => {
    const backend = new FakeBackend();
    const renderers = [new FakeRenderer(), new FakeRenderer()];
    let made = 0;

    const view = (
      <TerminalView
        label="tree:a"
        command=""
        seed="echo hi"
        backend={backend}
        createRenderer={() => renderers[made++] ?? new FakeRenderer()}
      />
    );
    const { rerender } = render(<StrictMode>{view}</StrictMode>);
    await waitFor(() => expect(backend.attaches.length).toBe(1));

    // One process, opened once, then re-attached by the second run. (Whether
    // the first run also got as far as detaching depends on whether `open` had
    // resolved by then; either way the attach replaces the sink, so what
    // matters is that no second session exists and none was killed.)
    expect(backend.opens).toBe(1);
    expect(backend.closed).toEqual([]);
    // ...and the seed ran exactly once, not once per effect run.
    expect(backend.seeded).toEqual([[7, "echo hi"]]);

    rerender(<StrictMode>{view}</StrictMode>);
    expect(backend.opens).toBe(1);
  });

  /** An adopted session outlives a pane that gave up on it — closing one on the
   *  way out would kill work this page never started. */
  test("a pane that unmounts mid-attach does not close what it adopted", async () => {
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();
    let settle: (a: Attached) => void = () => {};
    backend.attach = (_id, _anchor, handlers) => {
      backend.handlers = handlers;
      return new Promise<Attached>((resolve) => {
        settle = resolve;
      });
    };

    const { unmount } = render(
      <TerminalView
        label="tree:a"
        adoptId={42}
        backend={backend}
        createRenderer={() => renderer}
      />,
    );
    unmount();
    await act(async () => {
      settle({ epoch: "e1", seq: 0, mode: "tail" });
    });

    expect(backend.closed).toEqual([]);
  });
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
      <TerminalView
        active={false}
        label="tree:a"
        backend={backend}
        createRenderer={() => renderer}
      />,
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
    rerender(
      <TerminalView active label="tree:a" backend={backend} createRenderer={() => renderer} />,
    );
    act(() => {
      FakeResizeObserver.fireAll();
      vi.advanceTimersByTime(200);
    });
    expect(backend.resized).toEqual([[80, 24]]);
  });

  // The bug: dragging the sidebar fast painted the terminal over the pane beside
  // it. xterm sizes its screen element and canvases from the GRID, and nothing in
  // its stylesheet clips them, so while the grid lagged the shrinking box the
  // canvas drew outside the pane. The debounce was what made it lag: a fast drag
  // is a continuous burst, so the timer never fired until the drag paused.
  // The renderer must therefore refit on every tick; only the SIGWINCH waits.
  test("refits the renderer on every tick, and sends one PTY resize once the burst settles", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const renderer = new FakeRenderer();
    const backend = new FakeBackend();

    render(
      <TerminalView active label="tree:a" backend={backend} createRenderer={() => renderer} />,
    );
    await waitFor(() => expect(backend.opened).toBeTruthy());
    vi.useFakeTimers();
    const before = renderer.fits;

    // A drag: several observer ticks, none of them separated by a settle window.
    act(() => {
      for (const cols of [96, 92, 88]) {
        renderer.size = { cols, rows: 30 };
        FakeResizeObserver.fireAll();
        vi.advanceTimersByTime(16);
      }
    });
    // Every tick refit — the canvas never trails the box, at any drag speed.
    expect(renderer.fits - before).toBe(3);
    // ...and not one of them woke the shell up.
    expect(backend.resized).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(backend.resized).toEqual([[88, 30]]);
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

  const { unmount } = render(
    <TerminalView label="tree:a" backend={backend} createRenderer={() => renderer} />,
  );
  unmount();
  expect(renderer.disposed).toBe(true);

  await act(async () => {
    fail(new Error("no such cwd"));
  });

  expect(renderer.written).toEqual([]);
});
