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

import { DEFAULT_ACCENT } from "../../theme/colors";
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
// directly — resolve the live value each time a theme is built instead of
// baking in the app's default accent hex.
const liveAccent = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || DEFAULT_ACCENT;

const themeFor = (mode: string | null) => {
  const accent = liveAccent();
  return {
    ...(mode === "light" ? LIGHT_THEME : DARK_THEME),
    cursor: accent,
    selectionBackground: `${accent}33`,
  };
};

/** Pulls the `--accent` declaration out of a raw `style` attribute string, so
 *  the mutation observer below can tell whether an accent change is what
 *  triggered a `style` mutation without forcing a style recalc via
 *  `getComputedStyle` on every call (that attribute also carries
 *  `--sidebar-width`, which is written on every pointermove of a sidebar
 *  drag). */
const accentDeclaration = (styleText: string | null) =>
  styleText?.match(/--accent:\s*([^;]+)/)?.[1]?.trim();

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
    // Default handler is `window.open`, which WKWebView doesn't route to the
    // system browser — send matched links through the opener plugin instead.
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    // Re-theme live when the app theme (data-theme on <html>) flips, or when
    // the accent CSS var changes. Both land as attribute mutations on the
    // same <html> element (data-theme / inline style respectively).
    if (typeof MutationObserver !== "undefined") {
      const html = document.documentElement;
      this.themeObserver = new MutationObserver((mutations) => {
        const accentChanged = mutations.some(
          (m) =>
            m.attributeName === "style" &&
            accentDeclaration(m.oldValue) !== accentDeclaration(html.getAttribute("style")),
        );
        const themeChanged = mutations.some((m) => m.attributeName === "data-theme");
        if (accentChanged || themeChanged) {
          this.term.options.theme = themeFor(html.getAttribute("data-theme"));
        }
      });
      this.themeObserver.observe(html, {
        attributes: true,
        attributeFilter: ["data-theme", "style"],
        attributeOldValue: true,
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
