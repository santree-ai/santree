import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WEBGL_CONTEXTS, withAlpha, XtermRenderer } from "./XtermRenderer";

/** Fakes for xterm + its WebGL addon: the pool logic under test is about how many
 *  addons are alive and which ones get disposed, so the fakes only need to record
 *  that (a real WebGL context needs a real GPU-backed webview). */
const { FakeWebgl, webgl } = vi.hoisted(() => {
  const webgl: FakeWebgl[] = [];
  class FakeWebgl {
    disposed = false;
    private lossCb?: () => void;
    constructor() {
      webgl.push(this);
    }
    onContextLoss(cb: () => void) {
      this.lossCb = cb;
    }
    dispose() {
      this.disposed = true;
    }
    /** Simulate the webview dropping this context (GPU reset, too many contexts). */
    loseContext() {
      this.lossCb?.();
    }
  }
  return { FakeWebgl, webgl };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebgl }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    open() {}
    loadAddon() {}
    write() {}
    onData() {}
    resize() {}
    focus() {}
    dispose() {}
  },
}));

describe("withAlpha", () => {
  it("expands a hex accent to an rgba() literal xterm can parse", () => {
    // The two live accents (dark, then light) plus a 3-digit form.
    expect(withAlpha("#ffffff", 0.2)).toBe("rgba(255, 255, 255, 0.2)");
    expect(withAlpha("16171b", 0.2)).toBe("rgba(22, 23, 27, 0.2)");
    expect(withAlpha("#0af", 0.5)).toBe("rgba(0, 170, 255, 0.5)");
  });

  // The old `${accent}33` suffix produced garbage ("var(--accent)33",
  // "rgb(1,2,3)33") the moment the accent wasn't a plain hex. Pass those through
  // instead — xterm parses rgb()/named colors itself, opaque but not broken.
  it("passes a non-hex color through rather than concatenating an alpha suffix", () => {
    expect(withAlpha("rgb(1, 2, 3)", 0.2)).toBe("rgb(1, 2, 3)");
    expect(withAlpha("var(--accent)", 0.2)).toBe("var(--accent)");
  });
});

/** WebGL contexts currently held across all terminals. */
const live = () => webgl.filter((w) => !w.disposed);

const renderers: XtermRenderer[] = [];
function mounted(): XtermRenderer {
  const r = new XtermRenderer();
  renderers.push(r);
  r.mount(document.createElement("div"));
  return r;
}

describe("XtermRenderer WebGL contexts", () => {
  beforeEach(() => {
    webgl.length = 0;
  });

  afterEach(() => {
    // The pool is module state — leave it empty for the next test.
    for (const r of renderers) r.dispose();
    renderers.length = 0;
  });

  it("gives a mounted terminal a WebGL context", () => {
    mounted();
    expect(live()).toHaveLength(1);
  });

  it("caps live contexts, evicting the least-recently-activated terminal", () => {
    const all = Array.from({ length: MAX_WEBGL_CONTEXTS + 3 }, () => mounted());
    expect(all).toHaveLength(MAX_WEBGL_CONTEXTS + 3);

    // Never more than the cap alive — past it WebKit would start silently killing
    // contexts, and xterm never recovers from that.
    expect(live()).toHaveLength(MAX_WEBGL_CONTEXTS);
    // The three oldest lost theirs (they render through the DOM fallback now).
    expect(webgl.slice(0, 3).every((w) => w.disposed)).toBe(true);
  });

  it("re-acquires a context when an evicted terminal is activated again", () => {
    const first = mounted();
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) mounted();
    expect(webgl[0].disposed).toBe(true); // `first` was evicted

    first.focus(); // activation = "this pane is on screen again"

    const reacquired = webgl.at(-1);
    expect(reacquired?.disposed).toBe(false);
    expect(live()).toHaveLength(MAX_WEBGL_CONTEXTS);
  });

  it("does not stack a second context on an already-active terminal", () => {
    const r = mounted();
    r.focus();
    r.focus();
    expect(webgl).toHaveLength(1);
    expect(live()).toHaveLength(1);
  });

  it("re-attaches after a context loss instead of degrading forever", () => {
    const r = mounted();
    webgl[0].loseContext();
    expect(live()).toHaveLength(0);

    r.focus();

    expect(webgl).toHaveLength(2);
    expect(live()).toHaveLength(1);
  });

  it("gives up on WebGL after repeated context losses (a broken GPU, not a full pool)", () => {
    const r = mounted();
    webgl[0].loseContext();
    r.focus();
    webgl[1].loseContext();

    r.focus();

    // No third attempt — the terminal stays on the DOM renderer rather than
    // thrashing context creation.
    expect(webgl).toHaveLength(2);
    expect(live()).toHaveLength(0);
  });

  it("frees its context on dispose, so a closed tab doesn't hold a slot", () => {
    const r = mounted();
    expect(live()).toHaveLength(1);

    r.dispose();

    expect(live()).toHaveLength(0);
    // Disposed renderers must not creep back into the pool.
    r.focus();
    expect(live()).toHaveLength(0);
  });
});
