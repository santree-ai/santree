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
 *
 * Two properties keep an overlay honest, and both are load-bearing:
 *
 *  1. **It clips.** xterm sizes `.xterm-screen` and its canvases from the *grid*
 *     (`dimensions.css.canvas`), not from the element it was mounted in, and
 *     nothing in xterm's stylesheet clips them. A grid that is momentarily wider
 *     than its box therefore paints straight over whatever is beside the pane —
 *     the Trees right panel, at z-index 30. `overflow-hidden` here makes that
 *     structurally impossible, whatever the grid does.
 *  2. **Its geometry is written in the same frame as the layout change.** See
 *     `place`.
 */

import { useLayoutEffect, useRef, useState } from "react";

import { paneAddress } from "./paneAddress";
import { useAdoptedSessions, useTerminals } from "./TerminalsContext";
import { TerminalView } from "./TerminalView";

/** Height of the window's draggable title bar. A background session that has
 *  never been embedded parks below it, so its grid starts at a plausible size
 *  rather than overlapping chrome it can't be seen through. */
const TOP_BAR = 46;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const rectOf = (el: HTMLElement): Rect => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

/**
 * Put the overlay on a rect — straight onto the element, deliberately.
 *
 * Every caller below runs inside a ResizeObserver / scroll / resize callback,
 * which the browser dispatches *after* layout and *before* paint: a style
 * written here lands in the same frame as the layout change that provoked it.
 * Routed through React state (as this used to be) the re-render is scheduled as
 * a task and the overlay paints one frame behind its host — during a fast
 * sidebar drag, tens of pixels of terminal drawn outside the pane it belongs to.
 * There is no cheap way to win that race; not entering it is the fix.
 */
function place(el: HTMLElement, r: Rect) {
  el.style.top = `${r.top}px`;
  el.style.left = `${r.left}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

export function TerminalLayer() {
  const { tabs, close, embed, detachEmbeds, registerPane } = useTerminals();
  const adopted = useAdoptedSessions();

  // The overlay element itself, as state rather than a ref: the layer renders
  // nothing until adoption settles, so "the element exists" is a real input to
  // the effect below, not something it can assume.
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const host = embed?.host ?? null;
  const embedded = host !== null;
  const shownKey = embedded ? (embed?.key ?? null) : null;

  // The geometry the overlay had while it was last embedded. When the embed goes
  // away (a diff opened over the terminal, or a tab switch) the hidden overlay
  // keeps the *same* geometry instead of snapping to the full content area. That
  // snap would resize the xterm grid and make zsh reprint its prompt — a spurious
  // blank prompt line every time you came back.
  const lastRect = useRef<Rect | null>(null);

  useLayoutEffect(() => {
    if (!layer) return;
    if (!host) {
      // Hidden: frozen at the last embed geometry (see above), or — for a session
      // launched in the background that has never been shown — parked at a
      // plausible content-area size so its grid isn't degenerate before first view.
      place(
        layer,
        lastRect.current ?? {
          top: TOP_BAR,
          left: 0,
          width: window.innerWidth,
          height: Math.max(0, window.innerHeight - TOP_BAR),
        },
      );
      return;
    }
    const apply = () => {
      lastRect.current = rectOf(host);
      place(layer, lastRect.current);
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : undefined;
    ro?.observe(host);
    window.addEventListener("resize", apply);
    // Capture-phase scroll so the overlay tracks the host inside any scroll
    // container (e.g. the embedded login terminal in the scrollable settings pane).
    window.addEventListener("scroll", apply, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener("scroll", apply, true);
    };
  }, [host, layer]);

  // Nothing until we know what this page inherited. A pane that mounts before
  // the answer spawns a second session for work that is already running, and its
  // mount effect never re-runs to correct it — see `useAdoptedSessions`.
  if (!adopted.ready) return null;

  return (
    <div
      ref={setLayer}
      // Geometry is owned by the layout effect above, never by this style object —
      // React must not have an opinion it would rewrite on an unrelated re-render.
      className={`fixed overflow-hidden bg-panel ${
        embedded ? "" : "invisible pointer-events-none"
      }`}
      style={{ zIndex: embedded ? 30 : -1 }}
    >
      {tabs.map((t) => (
        // Keep every pane laid out at full size (not display:none) so xterm
        // never reflows from a zero-size state when switching panes/tabs.
        <div
          key={t.key}
          className={`absolute inset-0 overflow-hidden p-2 ${
            t.key === shownKey ? "" : "invisible pointer-events-none"
          }`}
        >
          <TerminalView
            cwd={t.cwd}
            command={t.command}
            args={t.args}
            // The tab's `refId` IS the backend's label and the DB's `term_key`,
            // and its agent's kind is the provider column beside it — one
            // identity for the surface, in the two fields the durable row
            // already uses, so a reloaded page can match a live session to the
            // pane that owns it without inventing a second one.
            label={t.refId ?? t.key}
            agentKind={t.agent?.kind ?? null}
            adoptId={
              t.refId ? adopted.sessions.get(paneAddress(t.refId, t.agent?.kind)) : undefined
            }
            seed={t.seed}
            active={embedded && t.key === shownKey}
            onReady={(handle) => registerPane(t.key, handle)}
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
