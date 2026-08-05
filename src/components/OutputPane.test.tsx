import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAll, startRun } from "../state/streamRuns";
import { OutputPane } from "./OutputPane";

/** The renderer, recorded rather than rendered: these tests are about *what* the
 *  pane feeds the VT engine across a resize, not about xterm's own painting (which
 *  needs a canvas jsdom doesn't have). `fit` reports whatever grid the test set. */
const spies = vi.hoisted(() => ({
  writes: [] as string[],
  resets: 0,
  grid: { cols: 120, rows: 40 },
}));

vi.mock("../features/terminal/XtermRenderer", () => ({
  XtermRenderer: class {
    mount() {}
    dispose() {}
    write(chunk: string) {
      spies.writes.push(chunk);
    }
    reset() {
      spies.resets++;
    }
    fit() {
      return spies.grid;
    }
    resize() {}
  },
}));

/** jsdom has no ResizeObserver, so the pane's observer branch is dead unless we
 *  supply one we can fire on demand. */
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

const KEY = "dev-build:/repo";

/** Seed a run holding `chunks`, as the backend's stream events would leave it. */
function seed(chunks: string[]) {
  let sink: { onmessage: (e: unknown) => void } = { onmessage: () => {} };
  startRun(
    KEY,
    () => {
      sink = { onmessage: () => {} };
      return sink as never;
    },
    () => new Promise(() => {}),
    0,
  );
  for (const text of chunks) sink.onmessage({ type: "chunk", text });
}

describe("OutputPane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spies.writes = [];
    spies.resets = 0;
    spies.grid = { cols: 120, rows: 40 };
    FakeResizeObserver.reset();
    resetAll();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-emulates the whole transcript when the width changes", () => {
    seed(["first chunk\r\n", "second chunk\r\n"]);
    render(<OutputPane runKey={KEY} label="pnpm tauri build" />);
    spies.writes = [];
    spies.resets = 0;

    // Drag the pane wider. xterm's own reflow drops the oldest rows once narrowing
    // has pushed them past `scrollback`, and widening can't get them back — so the
    // pane must rebuild from the stored bytes rather than trust the live buffer.
    spies.grid = { cols: 200, rows: 40 };
    FakeResizeObserver.fireAll();
    vi.advanceTimersByTime(200);

    expect(spies.resets).toBe(1);
    expect(spies.writes).toEqual(["first chunk\r\n", "second chunk\r\n"]);
  });

  it("does not re-emulate when only the height changes", () => {
    seed(["only chunk\r\n"]);
    render(<OutputPane runKey={KEY} label="pnpm tauri build" />);
    spies.writes = [];
    spies.resets = 0;

    // A vertical drag reflows nothing, so replaying would be pure wasted work on
    // every pixel of a sidebar drag.
    spies.grid = { cols: 120, rows: 12 };
    FakeResizeObserver.fireAll();
    vi.advanceTimersByTime(200);

    expect(spies.resets).toBe(0);
    expect(spies.writes).toEqual([]);
  });

  it("reports the fitted grid so the backend can re-grid the PTY", () => {
    seed([]);
    const onResize = vi.fn();
    render(<OutputPane runKey={KEY} label="build" onResize={onResize} />);

    expect(onResize).toHaveBeenCalledWith(120, 40);

    // Same grid on a later tick: no IPC, no SIGWINCH for a resize that isn't one.
    onResize.mockClear();
    FakeResizeObserver.fireAll();
    expect(onResize).not.toHaveBeenCalled();

    spies.grid = { cols: 200, rows: 40 };
    FakeResizeObserver.fireAll();
    expect(onResize).toHaveBeenCalledWith(200, 40);
  });
});
