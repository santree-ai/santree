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

import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { PaneLink } from "../../bindings";
import { onDaedalus } from "../../lib/daedalusLink";
import { useRepos, useServerStatus } from "../../lib/queries";
import { serverStateView } from "../../lib/serverStatus";
import { parseTermKey } from "../agents/registry";
import { type AgentTarget, useOpenAgent } from "../agents/useOpenAgent";
import { openTerminalLink } from "../web/links";
import type { TerminalEmbed, TerminalTab } from "./orchestrator";
import { paneAddress } from "./paneAddress";
import { RELAYOUT_EVENT } from "./relayout";
import { useAdoptedSessions, useTerminals } from "./TerminalsContext";
import { TerminalView } from "./TerminalView";
import type { SessionId } from "./types";

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

/**
 * Which adopted session each pane attaches to — and that a session is attached
 * once.
 *
 * `adopted.sessions` only ever grows, so reading it live in every render would
 * hand a session's id to every pane that ever mounts at its address: after the
 * agent ended and the user resumed it, the new pane would attach the id of a
 * session that is gone and, believing it adopted, never be seeded. A pane's id is
 * therefore settled once, when the pane first renders, and a spent id is never
 * given out again. (A tab keeps its address for life, so "the pane" and "the
 * tab" are the same thing here.)
 *
 * The one later claim is {@link reclaim}: a pane whose session was lost may be
 * handed the session a server that came up late then adopted for its address.
 */
function useAdoptClaims(adopted: ReturnType<typeof useAdoptedSessions>) {
  const claims = useRef(new Map<string, SessionId | undefined>());
  const spent = useRef(new Set<SessionId>());
  // A new object only when the adopted sessions change: that is the cue for a
  // lost pane to look again (see `useReclaimLost`).
  return useMemo(() => {
    const take = (t: TerminalTab): SessionId | undefined => {
      if (!t.refId) return undefined;
      const id = adopted.sessions.get(paneAddress(t.refId, t.agent?.kind));
      if (id === undefined || spent.current.has(id)) return undefined;
      spent.current.add(id);
      return id;
    };
    return {
      /** The session this tab's pane attaches to as it mounts, or undefined to
       *  open one. Idempotent per tab, so a re-render (or StrictMode's second)
       *  agrees. */
      claimFor: (t: TerminalTab): SessionId | undefined => {
        if (!claims.current.has(t.key)) claims.current.set(t.key, take(t));
        return claims.current.get(t.key);
      },
      /** A session not yet attached anywhere for this tab's address, if one has
       *  been adopted since — taken, so no other pane can have it. */
      reclaim: (t: TerminalTab): boolean => {
        const id = take(t);
        if (id !== undefined) claims.current.set(t.key, id);
        return id !== undefined;
      },
    };
  }, [adopted.sessions]);
}

/**
 * Which panes are `lost`, and handing each one a session that a server which
 * came up late then adopted for its address. The pane is remounted on it (its
 * mount effect runs once; the old view only detaches, as ever). Only a lost pane:
 * one with a session of its own must never be swapped for another.
 */
function useReclaimLost(tabs: TerminalTab[], claims: ReturnType<typeof useAdoptClaims>) {
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  const onLink = useCallback((key: string, link: PaneLink) => {
    setLost((prev) => {
      if ((link === "lost") === prev.has(key)) return prev;
      const next = new Set(prev);
      if (link === "lost") next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    if (lost.size === 0) return;
    const open = new Set(tabs.map((t) => t.key));
    // A pane that found a session is no longer lost; a closed tab is no pane.
    const settled = [
      ...[...lost].filter((key) => !open.has(key)),
      ...tabs.filter((t) => lost.has(t.key) && claims.reclaim(t)).map((t) => t.key),
    ];
    if (settled.length === 0) return;
    setLost((prev) => {
      const next = new Set(prev);
      for (const key of settled) next.delete(key);
      return next;
    });
  }, [lost, tabs, claims]);
  return onLink;
}

/** A click on Resume, waiting for the lost pane to be gone. */
interface PendingResume {
  key: string;
  target: AgentTarget;
  /** The owning surface's own Resume (`TerminalEmbed.onResume`), when it has one. */
  surfaceResume?: () => void;
}

/**
 * Resume a lost agent: the pane closes, and once nothing of it is left the agent
 * is resumed. A surface that shows its own "session ended" offer once its pane
 * closes (Triage's investigation, Reviews' AI review) carried its Resume on the
 * embed, and that is called: the click is the one it would have asked for, so
 * the conversation resumes once. An agent tab that is a row — a worktree's, a
 * review checkout's, a triage ticket's own — does the same, in place: its row is
 * held through the gap, so the relaunch finds the conversation still bound to it
 * (`useLostTabResume`). Anything else (a pane no surface is showing) is asked to
 * be opened again — the path clicking the agent in the sidebar already takes for
 * an agent with no live terminal (`useOpenAgent`).
 * Either way it happens once, on a click, and never on santree's own decision.
 * It waits on the pane being out of the registry, not on a clock.
 */
function useResume() {
  const { tabs } = useTerminals();
  const openAgent = useOpenAgent();
  const [pending, setPending] = useState<PendingResume | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (tabs.some((t) => t.key === pending.key)) return;
    setPending(null);
    if (pending.surfaceResume) pending.surfaceResume();
    else openAgent(pending.target);
  }, [pending, tabs, openAgent]);
  return setPending;
}

export function TerminalLayer() {
  const { tabs, close, embeds, embed, detachEmbeds, registerPane, holdRow, reportLink } =
    useTerminals();
  const adopted = useAdoptedSessions();
  const claims = useAdoptClaims(adopted);
  const onLink = useReclaimLost(tabs, claims);
  const resume = useResume();
  // The local server's state. A pane whose session is gone can only be resumed
  // into a server that can take the new one.
  const { data: server } = useServerStatus();
  const serverView = server && serverStateView(server.state);
  // Where a local pane that is waiting too long should send the user: there is
  // only a server to look at when one is in use.
  const localHint =
    server && server.state.kind !== "Off"
      ? "Check the server in Settings → Terminal, or the dot in the status bar."
      : undefined;
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
  // Drop a tab whose session is over: the pane disappears instead of showing a
  // dead terminal, and any embed pointed at it is released.
  const end = (key: string) => {
    detachEmbeds(key);
    close(key);
  };
  return (
    <>
      {tabs.map((t) => {
        const agent = t.agent;
        const host = hosts.get(t.key) ?? null;
        const remote = onDaedalus(repos, t.cwd);
        return (
          <LayerPane
            key={t.key}
            tab={t}
            embed={host}
            focused={t.key === embed?.key}
            parking={parking}
            untrusted={remote}
            adoptId={claims.claimFor(t)}
            // A Daedalus pane's session lives on the box, not in the local server.
            resumeBlocked={remote ? undefined : serverView?.blocksResume}
            unansweredHint={remote ? "Check the link in Settings → Daedalus." : localHint}
            onLink={(link) => {
              onLink(t.key, link);
              // For a view that types into this pane while not showing it.
              reportLink(t.key, link);
            }}
            // A link opens in a Web tab of the surface the terminal is on.
            openLink={(url, event) => void openTerminalLink(t.refId, url, event)}
            onReady={(handle) => registerPane(t.key, handle)}
            // The process ended.
            onExit={() => end(t.key)}
            // The session is gone without having ended (`lost`): the user closes
            // the tab...
            onClose={() => end(t.key)}
            // ...or, for an agent, asks for its conversation back (see `useResume`).
            onResume={
              agent
                ? () => {
                    const origin = parseTermKey(agent.termKey);
                    // A tab row its surface resumes in place outlives its pane.
                    if (host?.onResume && origin.tabId) holdRow(agent.termKey);
                    end(t.key);
                    resume({
                      key: t.key,
                      target: { repo: agent.repo, origin, agentKind: agent.kind },
                      surfaceResume: host?.onResume,
                    });
                  }
                : undefined
            }
          />
        );
      })}
    </>
  );
}

function LayerPane({
  tab: t,
  embed,
  focused,
  parking,
  untrusted,
  adoptId,
  resumeBlocked,
  unansweredHint,
  onLink,
  openLink,
  onReady,
  onExit,
  onClose,
  onResume,
}: {
  tab: TerminalTab;
  embed: TerminalEmbed | null;
  focused: boolean;
  parking: MutableRefObject<Rect | null>;
  untrusted: boolean;
  /** The adopted session the pane attaches to (see `useAdoptClaims`). */
  adoptId: SessionId | undefined;
  /** Why Resume is unavailable, when it is. */
  resumeBlocked?: string;
  /** Where to look when the pane's host is slow to answer. */
  unansweredHint?: string;
  onLink: (link: PaneLink) => void;
  openLink: (url: string, event: MouseEvent) => void;
  onReady: Parameters<typeof TerminalView>[0]["onReady"];
  onExit: () => void;
  onClose: () => void;
  onResume?: () => void;
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
    // reflows from a zero-size state when it is shown again. Hidden, it is also
    // inert: nothing in it can take the keyboard (the view blurs its terminal
    // too — see `TerminalView`).
    <div
      ref={setPane}
      data-terminal-pane={t.key}
      className={`fixed overflow-hidden bg-panel p-2 ${shown ? "" : "invisible pointer-events-none"}`}
      style={{ zIndex: shown ? 30 : -1 }}
      inert={!shown}
      onPointerDownCapture={embed?.onActivate}
    >
      <TerminalView
        // The session it attaches to is part of what the view was mounted for.
        key={adoptId ?? "own"}
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
        adoptId={adoptId}
        seed={t.seed}
        active={shown}
        focused={shown && focused}
        onReady={onReady}
        onExit={onExit}
        onClose={onClose}
        onResume={onResume}
        resumeBlocked={resumeBlocked}
        unansweredHint={unansweredHint}
        onLink={onLink}
        openLink={openLink}
      />
    </div>
  );
}
