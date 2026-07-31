/**
 * The persistent terminal render layer. Mounted once at the app shell so PTY
 * sessions and their xterm state survive navigation between tabs.
 *
 * Every session is *embedded*: the layer is a fixed overlay positioned over a
 * host element some view registered (a worktree's terminal pane, the triage
 * Investigate tab, the Dev console, the Settings login box). On every other
 * route it stays mounted but hidden, so nothing reflows or dies when you switch
 * tabs.
 *
 * There is no standalone terminal page any more — a session belongs to the
 * surface that started it, and that surface hosts it.
 */

import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import { useTerminals } from "./TerminalsContext";
import { TerminalView } from "./TerminalView";

/** Height of the window title bar (matches ViewChrome's top bar). */
const TOP_BAR = 46;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Track an element's viewport rect, re-measuring on size/window changes. */
function useElementRect(el: HTMLElement | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.top === r.top &&
        prev.left === r.left &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : undefined;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    // Capture-phase scroll so the overlay tracks the host inside any scroll
    // container (e.g. the embedded login terminal in the scrollable settings pane).
    window.addEventListener("scroll", measure, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [el]);
  return rect;
}

export function TerminalLayer() {
  const { tabs, close, embed, detachEmbeds, registerInput } = useTerminals();

  // Live-measured rect, falling back to the rect captured at embed time so the
  // very first render is already correctly sized (no full-area flash that would
  // open the PTY too tall).
  const liveRect = useElementRect(embed?.host ?? null);
  const embedRect = liveRect ?? embed?.rect ?? null;
  const embedded = !!embed && !!embedRect;
  const shownKey = embedded ? embed.key : null;

  // Remember the last embed rect so that when the embed goes away (a diff opened
  // over the terminal, or a tab switch), the hidden overlay keeps the *same*
  // geometry instead of snapping to the full content area. That snap would resize
  // the xterm grid and make zsh reprint its prompt — a spurious blank prompt line
  // every time you came back. Frozen-at-last-size means no resize, no reprint.
  const lastEmbedRect = useRef<Rect | null>(null);
  if (embedded && embedRect) lastEmbedRect.current = embedRect;

  let style: CSSProperties;
  if (embedded) {
    style = {
      top: embedRect.top,
      left: embedRect.left,
      width: embedRect.width,
      height: embedRect.height,
      zIndex: 30,
    };
  } else if (lastEmbedRect.current) {
    // Hidden, but frozen at the last embed size (see above).
    const r = lastEmbedRect.current;
    style = { top: r.top, left: r.left, width: r.width, height: r.height, zIndex: -1 };
  } else {
    // Never embedded yet (a session launched in the background). Park it at a
    // plausible content-area size so its grid isn't degenerate before first view.
    style = { top: TOP_BAR, left: 0, right: 0, bottom: 0, zIndex: -1 };
  }

  return (
    <div
      className={`fixed bg-panel ${embedded ? "" : "invisible pointer-events-none"}`}
      style={style}
    >
      {tabs.map((t) => (
        // Keep every pane laid out at full size (not display:none) so xterm
        // never reflows from a zero-size state when switching panes/tabs.
        <div
          key={t.key}
          className={`absolute inset-0 p-2 ${
            t.key === shownKey ? "" : "invisible pointer-events-none"
          }`}
        >
          <TerminalView
            cwd={t.cwd}
            command={t.command}
            args={t.args}
            seed={t.seed}
            active={embedded && t.key === shownKey}
            onReady={(write) => registerInput(t.key, write)}
            onExit={() => {
              // The process ended — drop the session (so the pane disappears
              // instead of showing a dead terminal) and release any embed.
              detachEmbeds(t.key);
              close(t.key);
            }}
          />
        </div>
      ))}
    </div>
  );
}
