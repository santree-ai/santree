/**
 * The persistent terminal render layer. Mounted once at the app shell so PTY
 * sessions and their xterm state survive navigation between tabs.
 *
 * Every session is *embedded*: each pane is a fixed overlay positioned over the
 * host element some view registered for it (a worktree's terminal tab, the
 * triage Investigate tab, the Settings login box). Several can be on screen at
 * once — a split main area shows a terminal per group — and each follows its
 * own host. A pane with no host stays mounted but hidden, so nothing reflows or
 * dies when you switch tabs.
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

import { type MutableRefObject, useLayoutEffect, useRef, useState } from "react";

import { onDaedalus } from "../../lib/daedalusLink";
import { useRepos } from "../../lib/queries";
import type { TerminalEmbed, TerminalTab } from "./orchestrator";
import { paneAddress } from "./paneAddress";
import { RELAYOUT_EVENT } from "./relayout";
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
  const { tabs, close, embeds, embed, detachEmbeds, registerPane } = useTerminals();
  const adopted = useAdoptedSessions();
  // Which panes show a session on Daedalus, whose bytes are untrusted: decided
  // from the pane's cwd before its renderer exists, so the registry has to be
  // known before any pane mounts (a settled failure counts: nothing is shown
  // for a project santree couldn't list).
  const { data: repos, isFetched: reposKnown } = useRepos();
  // Where a session that has never been shown sits: the geometry of the last
  // embed anywhere, so its grid starts at the size it will most likely be shown
  // at rather than a size it will have to reflow from.
  const parking = useRef<Rect | null>(null);

  // Nothing until we know what this page inherited. A pane that mounts before
  // the answer spawns a second session for work that is already running, and its
  // mount effect never re-runs to correct it — see `useAdoptedSessions`. Nor
  // until the registry says which panes are on Daedalus (above).
  if (!adopted.ready || !reposKnown) return null;

  const hosts = new Map(embeds.map((e) => [e.key, e]));
  return (
    <>
      {tabs.map((t) => (
        <LayerPane
          key={t.key}
          tab={t}
          embed={hosts.get(t.key) ?? null}
          focused={t.key === embed?.key}
          parking={parking}
          untrusted={onDaedalus(repos, t.cwd)}
          adopted={adopted}
          onReady={(handle) => registerPane(t.key, handle)}
          onExit={() => {
            // The process ended — drop the session (so the pane disappears
            // instead of showing a dead terminal) and release any embed.
            detachEmbeds(t.key);
            close(t.key);
          }}
        />
      ))}
    </>
  );
}

function LayerPane({
  tab: t,
  embed,
  focused,
  parking,
  untrusted,
  adopted,
  onReady,
  onExit,
}: {
  tab: TerminalTab;
  embed: TerminalEmbed | null;
  focused: boolean;
  parking: MutableRefObject<Rect | null>;
  untrusted: boolean;
  adopted: ReturnType<typeof useAdoptedSessions>;
  onReady: Parameters<typeof TerminalView>[0]["onReady"];
  onExit: () => void;
}) {
  // The pane element itself, as state rather than a ref: "the element exists" is
  // a real input to the effect below.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const host = embed?.host ?? null;
  const shown = host !== null;

  // The geometry the pane had while it was last embedded. When the embed goes
  // away (a diff opened over the terminal, or a tab switch) the hidden pane
  // keeps the *same* geometry instead of snapping to some other box. That snap
  // would resize the xterm grid and make zsh reprint its prompt — a spurious
  // blank prompt line every time you came back.
  const lastRect = useRef<Rect | null>(null);

  useLayoutEffect(() => {
    if (!pane) return;
    if (!host) {
      // Hidden: frozen at the last embed geometry (see above), or — for a session
      // launched in the background that has never been shown — parked at a
      // plausible content-area size so its grid isn't degenerate before first view.
      place(
        pane,
        lastRect.current ??
          parking.current ?? {
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
      parking.current = lastRect.current;
      place(pane, lastRect.current);
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : undefined;
    ro?.observe(host);
    window.addEventListener("resize", apply);
    window.addEventListener(RELAYOUT_EVENT, apply);
    // Capture-phase scroll so the pane tracks the host inside any scroll
    // container (e.g. the embedded login terminal in the scrollable settings pane).
    window.addEventListener("scroll", apply, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
      window.removeEventListener(RELAYOUT_EVENT, apply);
      window.removeEventListener("scroll", apply, true);
    };
  }, [host, pane, parking]);

  return (
    // Geometry is owned by the layout effect above, never by this style object —
    // React must not have an opinion it would rewrite on an unrelated re-render.
    // Every pane stays laid out at full size (not display:none) so xterm never
    // reflows from a zero-size state when it is shown again.
    <div
      ref={setPane}
      data-terminal-pane={t.key}
      className={`fixed overflow-hidden bg-panel p-2 ${shown ? "" : "invisible pointer-events-none"}`}
      style={{ zIndex: shown ? 30 : -1 }}
      onPointerDownCapture={embed?.onActivate}
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
        untrusted={untrusted}
        adoptId={t.refId ? adopted.sessions.get(paneAddress(t.refId, t.agent?.kind)) : undefined}
        seed={t.seed}
        active={shown}
        focused={shown && focused}
        onReady={onReady}
        onExit={onExit}
      />
    </div>
  );
}
