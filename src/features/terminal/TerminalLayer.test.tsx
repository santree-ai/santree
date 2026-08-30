/**
 * The overlay's two contracts: where it draws, and how long the work behind it
 * lives.
 *
 * **Geometry.** The layer draws a terminal over a host element it does not own,
 * at z-index 30, so anything it gets wrong is painted on top of a neighbouring
 * pane. Two properties keep that honest: it clips whatever xterm draws to the
 * pane's box, and it takes its geometry from the live host rect at the moment
 * the layout changed — not from a React render scheduled afterwards, which is
 * what used to make a fast sidebar drag smear the terminal across the Trees
 * right panel.
 *
 * **Session lifetime.** A pane going away says nothing about whether the work in
 * it should stop, so the layer's teardown must *detach* and never `close` —
 * ending a session is an explicit act, and it happens in `close(key)` on the tab.
 * `TerminalView.test.tsx` pins that one line against an injected backend; what is
 * pinned here is the assembled path — the real default backend, the real
 * orchestrator, and the layer's own address lookup, which is what decides whether
 * a pane that comes back finds the session still running or spawns a second one
 * beside it.
 */
import { render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { TerminalRenderer } from "./types";

/** Session ids and pane refs the mocked backend and the tests must agree on.
 *  Hoisted because the mock factories below are, and they need them. */
const fixture = vi.hoisted(() => ({
  /** A pane with no inherited session: it has to spawn one. */
  freshRef: "tree:new",
  openedId: 7,
  /** A pane whose session a previous page load left running (see `adopt`). */
  adoptedRef: "tree:AK-1",
  adoptedId: 42,
}));

/** The renderers the layer built, in mount order. A pane's `onInput` callback is
 *  registered at the same moment its session id is — so `input` being set is the
 *  signal that the open/attach round-trip finished and the pane is live. */
const renderers = vi.hoisted(() => ({ live: [] as { input?: (data: string) => void }[] }));

vi.mock("./TauriBackend", () => ({
  tauriBackend: {
    // Keyed by pane *address*, both halves — the layer has to ask for the
    // surface AND the provider in it, or two agents on one surface get each
    // other's session (or, missing it entirely, a second one each).
    adopt: vi.fn(
      async () => new Map([[paneAddress(fixture.adoptedRef, "Codex"), fixture.adoptedId]]),
    ),
    open: vi.fn(async () => fixture.openedId),
    attach: vi.fn(async () => ({ epoch: "e", seq: 0, mode: "tail" })),
    detach: vi.fn(),
    write: vi.fn(),
    seed: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  },
}));

// xterm wants a real canvas and a real WebGL context; neither exists in jsdom,
// and none of what it draws is under test here.
vi.mock("./XtermRenderer", () => {
  class FakeRenderer implements TerminalRenderer {
    input?: (data: string) => void;
    constructor() {
      renderers.live.push(this);
    }
    mount() {}
    write() {}
    reset() {}
    onInput(cb: (data: string) => void) {
      this.input = cb;
    }
    onTitle() {}
    resize() {}
    fit() {
      return { cols: 80, rows: 24 };
    }
    focus() {}
    dispose() {}
  }
  return { XtermRenderer: FakeRenderer };
});

import { paneAddress } from "./paneAddress";
import { tauriBackend } from "./TauriBackend";
import { TerminalLayer } from "./TerminalLayer";
import { TerminalsProvider, useTerminals } from "./TerminalsContext";
import { type EmbeddedTerminalSpec, useEmbeddedTerminal } from "./useEmbeddedTerminal";

const backend = {
  open: vi.mocked(tauriBackend.open),
  attach: vi.mocked(tauriBackend.attach),
  detach: vi.mocked(tauriBackend.detach),
  close: vi.mocked(tauriBackend.close),
};

/** jsdom has no ResizeObserver; this one can be fired on demand. */
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

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** jsdom lays nothing out, so the host reports whatever the test last said. */
function stubRect(el: HTMLElement, box: Box) {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
    }) as DOMRect;
}

/** A view that claims the inline slot for a host of a known size. */
function Host({ box, claim = true }: { box: Box; claim?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { attachEmbed } = useTerminals();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !claim) return;
    stubRect(el, box);
    return attachEmbed({ host: el, key: "term-0" });
  }, [attachEmbed, box, claim]);
  return <div ref={ref} data-testid="host" />;
}

const overlay = (container: HTMLElement) => container.querySelector<HTMLElement>("div.fixed");

const geometry = (el: HTMLElement) => ({
  top: el.style.top,
  left: el.style.left,
  width: el.style.width,
  height: el.style.height,
});

const settled = async (container: HTMLElement) => {
  // The layer renders nothing until adoption settles (see `useAdoptedSessions`).
  await waitFor(() => expect(overlay(container)).not.toBeNull());
  return overlay(container) as HTMLElement;
};

describe("TerminalLayer", () => {
  afterEach(() => {
    FakeResizeObserver.reset();
    vi.unstubAllGlobals();
  });

  test("sits exactly on the host rect, and clips what it draws to it", async () => {
    const { container } = render(
      <TerminalsProvider>
        <Host box={{ top: 46, left: 260, width: 800, height: 520 }} />
        <TerminalLayer />
      </TerminalsProvider>,
    );

    const layer = await settled(container);
    expect(geometry(layer)).toEqual({
      top: "46px",
      left: "260px",
      width: "800px",
      height: "520px",
    });
    // The clip is the half of the fix that holds at ANY drag speed: xterm sizes
    // its screen element from the grid, not from this box, and nothing in xterm's
    // own stylesheet keeps an over-sized canvas inside the pane.
    expect(layer.className).toContain("overflow-hidden");
  });

  // The regression. The observer fires after layout and before paint, so the new
  // geometry has to be on the element by the time that callback returns. It used
  // to go through React state instead, which lands a frame later — during a fast
  // sidebar drag, tens of pixels of terminal drawn over the pane next door.
  test("follows the host within the resize callback, with no React render in between", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { container } = render(
      <TerminalsProvider>
        <Host box={{ top: 46, left: 260, width: 800, height: 520 }} />
        <TerminalLayer />
      </TerminalsProvider>,
    );

    const layer = await settled(container);
    const host = container.querySelector<HTMLElement>('[data-testid="host"]') as HTMLElement;

    // The sidebar was dragged 120px to the right: the pane moved and narrowed.
    stubRect(host, { top: 46, left: 380, width: 680, height: 520 });
    // Deliberately NOT wrapped in `act` — nothing may need to re-render for this
    // to be true.
    FakeResizeObserver.fireAll();

    expect(geometry(layer)).toEqual({
      top: "46px",
      left: "380px",
      width: "680px",
      height: "520px",
    });
  });

  // Frozen-at-last-size, not snapped-to-full-area: a hidden overlay that resized
  // would resize the xterm grid with it, and zsh reprints its prompt on every
  // SIGWINCH — a blank prompt line each time you came back to the tab.
  test("keeps the last embed geometry when the host goes away", async () => {
    const box = { top: 46, left: 260, width: 800, height: 520 };
    const { container, rerender } = render(
      <TerminalsProvider>
        <Host box={box} />
        <TerminalLayer />
      </TerminalsProvider>,
    );
    const layer = await settled(container);

    rerender(
      <TerminalsProvider>
        <Host box={box} claim={false} />
        <TerminalLayer />
      </TerminalsProvider>,
    );

    expect(geometry(layer)).toEqual({
      top: "46px",
      left: "260px",
      width: "800px",
      height: "520px",
    });
    expect(layer.className).toContain("invisible");
  });
});

/**
 * What a pane costs when it goes away. The rule is one line in `TerminalView`'s
 * teardown — detach, never close — and it is the difference between a reload
 * costing you the view and costing you the work. These pin it through the layer
 * that actually mounts those panes.
 */
describe("TerminalLayer session lifetime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderers.live.length = 0;
  });

  /** A pane opened the way every view opens one: `useEmbeddedTerminal` ensures
   *  the session and points the layer at this host. */
  function Pane({ spec }: { spec: EmbeddedTerminalSpec }) {
    const { hostRef } = useEmbeddedTerminal({ spec });
    return <div ref={hostRef} />;
  }

  const mount = (spec: EmbeddedTerminalSpec) =>
    render(
      <TerminalsProvider>
        <Pane spec={spec} />
        <TerminalLayer />
      </TerminalsProvider>,
    );

  /** Resolves once the nth pane's session is live (see `renderers`). */
  const livePane = async (nth: number) =>
    await waitFor(() => expect(renderers.live[nth]?.input).toBeDefined());

  test("a pane that goes away detaches its session and never closes it", async () => {
    const { unmount } = mount({ title: "shell", source: "shell", refId: fixture.freshRef });
    await livePane(0);
    expect(backend.open).toHaveBeenCalledTimes(1);

    // The user navigated away, or the window reloaded. Neither is a decision to
    // stop the process.
    unmount();

    expect(backend.detach).toHaveBeenCalledWith(fixture.openedId);
    expect(backend.close).not.toHaveBeenCalled();
  });

  /** The other half: what the pane does on the way back in. The session is still
   *  running, and the layer finds it by the pane's full address — surface plus
   *  provider — so a reload re-attaches rather than spawning a second agent
   *  beside the one already working. */
  test("a pane that comes back attaches to the live session instead of opening a second", async () => {
    const spec: EmbeddedTerminalSpec = {
      title: "AK-1",
      source: "issue",
      refId: fixture.adoptedRef,
      agent: { kind: "Codex", repo: "/repo", termKey: fixture.adoptedRef },
    };

    const first = mount(spec);
    await livePane(0);
    // `fresh`, not `unknown`: this xterm was just built, so the backlog it gets
    // back cannot duplicate anything already on screen.
    expect(backend.attach).toHaveBeenCalledWith(
      fixture.adoptedId,
      { kind: "fresh" },
      expect.anything(),
    );
    expect(backend.open).not.toHaveBeenCalled();

    first.unmount();
    expect(backend.detach).toHaveBeenCalledWith(fixture.adoptedId);
    expect(backend.close).not.toHaveBeenCalled();

    mount(spec);
    await livePane(1);
    expect(backend.attach).toHaveBeenCalledTimes(2);
    // The whole point: one session, two views of it.
    expect(backend.open).not.toHaveBeenCalled();
  });
});
