/**
 * The xterm.js implementation of `TerminalRenderer`.
 *
 * This is the ONLY module that imports xterm. Everything else depends on the
 * `TerminalRenderer` interface, so swapping the VT engine later (e.g. a
 * libghostty-backed renderer) means replacing just this file.
 */
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { TerminalRenderer } from "./types";

const DARK_THEME = {
  background: "#0c0d10",
  foreground: "#d2d2da",
  cursor: "#2dd4a7",
  cursorAccent: "#0c0d10",
  selectionBackground: "#2dd4a733",
  black: "#15161a",
  brightBlack: "#5b5b63",
};

// A light terminal palette so the terminal follows the app's light theme. The
// ANSI colors are darkened a touch so shell output stays readable on white.
const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#1f2024",
  cursor: "#10b488",
  cursorAccent: "#ffffff",
  selectionBackground: "#2dd4a733",
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

const themeFor = (mode: string | null) => (mode === "light" ? LIGHT_THEME : DARK_THEME);

export class XtermRenderer implements TerminalRenderer {
  private term: Terminal;
  private fitAddon: FitAddon;
  private themeObserver?: MutationObserver;

  constructor() {
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
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
    this.term.loadAddon(new WebLinksAddon());

    // Re-theme live when the app theme (data-theme on <html>) changes.
    if (typeof MutationObserver !== "undefined") {
      this.themeObserver = new MutationObserver(() => {
        this.term.options.theme = themeFor(document.documentElement.getAttribute("data-theme"));
      });
      this.themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    }
  }

  mount(el: HTMLElement) {
    this.term.open(el);
    // GPU rendering for smooth output; fall back to the DOM renderer if WebGL is
    // unavailable in this webview.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // No WebGL — xterm's default renderer handles it.
    }
  }

  write(data: Uint8Array | string) {
    this.term.write(data);
  }

  onInput(cb: (data: string) => void) {
    this.term.onData(cb);
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  fit() {
    this.fitAddon.fit();
    return { cols: this.term.cols, rows: this.term.rows };
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    this.themeObserver?.disconnect();
    this.term.dispose();
  }
}
