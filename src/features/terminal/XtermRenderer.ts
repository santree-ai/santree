/**
 * The xterm.js implementation of `TerminalRenderer`.
 *
 * This is the ONLY module that imports xterm. Everything else depends on the
 * `TerminalRenderer` interface, so swapping the VT engine later (e.g. a
 * libghostty-backed renderer) means replacing just this file.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { XTERM_ACCENT_FALLBACK } from "../../theme/colors";
import type { TerminalRenderer } from "./types";

const DARK_THEME = {
  background: "#0c0d10",
  foreground: "#d2d2da",
  cursorAccent: "#0c0d10",
  black: "#15161a",
  brightBlack: "#5b5b63",
};

// A light terminal palette so the terminal follows the app's light theme. The
// ANSI colors are darkened a touch so shell output stays readable on white.
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f2024",
  cursorAccent: "#ffffff",
  black: "#2b2c31",
  brightBlack: "#9a9ba2",
  red: "#c4332b",
  green: "#1f8b3b",
  yellow: "#9a6a00",
  blue: "#2563c4",
  magenta: "#8a4ad6",
  cyan: "#0e8fa6",
  white: "#2b2c31",
};

// xterm renders to canvas/WebGL, not CSS, so it can't take `var(--accent)`
// directly — resolve the live value each time a theme is built instead of baking
// in one theme's hex. `getComputedStyle` resolves a CSS-*declared* custom
// property, so this picks up whichever of the two `:root` accent literals the
// active `data-theme` selected.
const liveAccent = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
  XTERM_ACCENT_FALLBACK;

/** A translucent version of a color for xterm's theme. The app's `alpha()` helper
 *  emits `color-mix()`, which only a CSS engine understands — xterm parses the
 *  string itself, so it needs a literal. Expands a 3/6-digit hex to `rgba()`;
 *  anything else (an `rgb()`/named color someone sets `--accent` to) is passed
 *  through untouched rather than concatenated into a broken token. Exported for
 *  testing — see XtermRenderer.test.ts. */
export function withAlpha(color: string, opacity: number): string {
  const hex = color.replace(/^#/, "");
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return color;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

const themeFor = (mode: string | null) => {
  const accent = liveAccent();
  return {
    ...(mode === "light" ? LIGHT_THEME : DARK_THEME),
    cursor: accent,
    selectionBackground: withAlpha(accent, 0.2),
  };
};

/** WebKit only keeps ~16 live WebGL contexts per page; past that it silently
 *  drops the oldest ones, and an xterm whose context is lost that way never gets
 *  it back — it renders through the DOM fallback for the rest of the session. So
 *  we ration contexts ourselves instead: at most this many terminals hold one at
 *  a time (headroom left for the rest of the app's GPU surfaces), least-recently-
 *  activated first to lose it. Overflow terminals render through the DOM
 *  fallback deliberately, and take a context back when they're activated again. */
export const MAX_WEBGL_CONTEXTS = 8;

/** Renderers currently holding a WebGL context, least-recently-activated first. */
const webglPool: XtermRenderer[] = [];

/** A context can be lost for reasons we can't fix (GPU reset, driver crash); stop
 *  re-acquiring after a couple of losses so we don't thrash on a broken GPU. */
const MAX_CONTEXT_LOSSES = 2;

export class XtermRenderer implements TerminalRenderer {
  private term: Terminal;
  private fitAddon: FitAddon;
  private themeObserver?: MutationObserver;
  private webgl?: WebglAddon;
  private mounted = false;
  private disposed = false;
  private contextLosses = 0;

  /** `readOnly` is for panes that only ever *show* a process's output (the build
   *  and setup logs): no keystrokes are wired to anything, so a blinking cursor and
   *  a focusable textarea would only advertise an input that goes nowhere. */
  constructor(opts: { readOnly?: boolean } = {}) {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: !opts.readOnly,
      cursorInactiveStyle: opts.readOnly ? "none" : undefined,
      disableStdin: !!opts.readOnly,
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 10000,
      theme: themeFor(document.documentElement.getAttribute("data-theme")),
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    // Default handler is `window.open`, which WKWebView doesn't route to the
    // system browser — send matched links through the opener plugin instead.
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    // Re-theme live when the app theme flips. `data-theme` on <html> is the only
    // thing that moves the accent (each theme declares its own literal in CSS;
    // nothing writes `--accent` inline), so that one attribute is the whole
    // trigger.
    if (typeof MutationObserver !== "undefined") {
      const html = document.documentElement;
      this.themeObserver = new MutationObserver(() => {
        this.term.options.theme = themeFor(html.getAttribute("data-theme"));
      });
      this.themeObserver.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    }
  }

  mount(el: HTMLElement) {
    this.term.open(el);
    this.mounted = true;
    this.acquireWebgl();
  }

  /** Take (or re-take) a WebGL context, evicting the least-recently-activated
   *  terminal's when the pool is full. Falls back to xterm's DOM renderer when a
   *  context isn't available — the same way `mount` always has. */
  private acquireWebgl() {
    if (this.disposed || !this.mounted || this.contextLosses >= MAX_CONTEXT_LOSSES) return;
    const at = webglPool.indexOf(this);
    if (at !== -1) webglPool.splice(at, 1);
    if (this.webgl) {
      webglPool.push(this); // already have one — just refresh its MRU position
      return;
    }
    while (webglPool.length >= MAX_WEBGL_CONTEXTS) webglPool[0].releaseWebgl();
    try {
      const webgl = new WebglAddon();
      // A lost context can't be revived in place, and retrying immediately tends
      // to lose it again — drop to the DOM renderer and re-acquire the next time
      // this pane is activated.
      webgl.onContextLoss(() => {
        this.contextLosses++;
        this.releaseWebgl();
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
      webglPool.push(this);
    } catch {
      // No WebGL in this webview at all — don't keep asking for it.
      this.contextLosses = MAX_CONTEXT_LOSSES;
      this.webgl = undefined;
    }
  }

  /** Give up this terminal's WebGL context (xterm reverts to the DOM renderer). */
  private releaseWebgl() {
    const at = webglPool.indexOf(this);
    if (at !== -1) webglPool.splice(at, 1);
    this.webgl?.dispose();
    this.webgl = undefined;
  }

  write(data: Uint8Array | string) {
    this.term.write(data);
  }

  reset() {
    this.term.reset();
    this.term.clear();
  }

  onInput(cb: (data: string) => void) {
    this.term.onData(cb);
  }

  onTitle(cb: (title: string) => void) {
    this.term.onTitleChange(cb);
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  fit() {
    this.fitAddon.fit();
    return { cols: this.term.cols, rows: this.term.rows };
  }

  focus() {
    // Activation is the app's "this terminal is on screen" signal (TerminalView
    // focuses the visible pane), so it's also where an evicted — or context-lost —
    // terminal earns its GPU renderer back.
    this.acquireWebgl();
    this.term.focus();
  }

  dispose() {
    this.disposed = true;
    this.themeObserver?.disconnect();
    this.releaseWebgl();
    this.term.dispose();
  }
}
