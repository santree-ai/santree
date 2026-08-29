/**
 * The overlay's geometry contract.
 *
 * The layer draws a terminal over a host element it does not own, at z-index 30,
 * so anything it gets wrong is painted on top of a neighbouring pane. Two
 * properties keep that honest and both are pinned here: it clips whatever xterm
 * draws to the pane's box, and it takes its geometry from the live host rect at
 * the moment the layout changed — not from a React render scheduled afterwards,
 * which is what used to make a fast sidebar drag smear the terminal across the
 * Trees right panel.
 */
import { render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./TauriBackend", () => ({
  tauriBackend: {
    adopt: async () => new Map(),
    open: async () => 1,
    attach: async () => ({ epoch: "e", seq: 0, mode: "tail" }),
    detach: () => {},
    write: () => {},
    resize: () => {},
    close: () => {},
  },
}));

import { TerminalLayer } from "./TerminalLayer";
import { TerminalsProvider, useTerminals } from "./TerminalsContext";

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
