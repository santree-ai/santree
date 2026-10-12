/**
 * Wires a `TerminalRenderer` to a `TerminalBackend` for one PTY session:
 * opens the session, streams PTY output → renderer, renderer keystrokes → PTY,
 * keeps the PTY grid in sync with the visible size, and tears everything down on
 * unmount. Backend and renderer are injectable so the wiring is unit-testable
 * with fakes. No xterm import here — only the `TerminalRenderer` interface.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentKind } from "../../bindings";
import { useHeldFor } from "../../lib/useHeldFor";
import type { PaneHandle } from "./orchestrator";
import { paneAddress } from "./paneAddress";
import { clearSessionTitle, setSessionTitle } from "./sessionTitles";
import { tauriBackend } from "./TauriBackend";
import { LostSession, WaitingBadge } from "./TerminalOverlays";
import type { PaneLink, SessionId, TerminalBackend, TerminalRenderer } from "./types";
import { XtermRenderer } from "./XtermRenderer";

export interface TerminalViewProps {
  cwd?: string;
  /** Empty ⇒ the user's login shell. */
  command?: string;
  args?: string[];
  /** What this session is called to the backend — the surface's `term_key`,
   *  exactly. How a reloaded page finds this pane's session again. */
  label: string;
  /** Which agent this pane hosts, or `null` for a plain shell — the other half
   *  of the session's identity (see `paneAddress`). It reaches the backend as
   *  its own field, because `label` is joined byte-for-byte against
   *  `terminal_sessions.term_key`, which keys a surface's providers apart. */
  agentKind?: AgentKind | null;
  /** A live session from a previous page load to take over instead of spawning.
   *  When set, the pane attaches to it and catches up from what the backend
   *  kept; `command`/`seed` are not re-run, because the process they describe
   *  is already running. */
  adoptId?: SessionId;
  /** Optional initial input, sent as if typed (followed by Enter). */
  seed?: string;
  /** When this pane is on screen — it refits as its box changes, and once more
   *  when it comes back. */
  active?: boolean;
  /** When this pane takes the keyboard. Distinct from `active` because a split
   *  main area shows several panes and only one of them can have focus.
   *  Defaults to `active`. */
  focused?: boolean;
  /** Called once when the hosted process exits (so the tab can be torn down). */
  onExit?: () => void;
  /** The user closed a pane whose session is gone (`lost`). Ending the tab is
   *  the host's call, as it is for an exit; absent, the pane offers no Close. */
  onClose?: () => void;
  /** The user asked to pick a lost agent's conversation back up. A human click
   *  and nothing else: santree never resumes on its own (COMPLIANCE.md). Absent
   *  for a plain shell, which has nothing to resume. */
  onResume?: () => void;
  /** Why Resume cannot be clicked right now (the server it needs is not up). The
   *  button stays, disabled, with this beside it. */
  resumeBlocked?: string;
  /** Where to look when the pane has waited on its host too long: the place that
   *  shows that host's state (the local server's card, the Daedalus link). Absent
   *  when there is no such place, and the pane only says it is waiting. */
  unansweredHint?: string;
  /** Told whenever the session's reachability changes, so the host can act on a
   *  pane that is `lost` (a session adopted late for it). */
  onLink?: (link: PaneLink) => void;
  /** Called once the PTY is live, handing out this pane's imperative handle:
   *  how to end it. Returns a cleanup fn, run when the pane tears down. */
  onReady?: (handle: PaneHandle) => (() => void) | undefined;
  /** The session's bytes come from Daedalus, not this Mac: they are untrusted
   *  (design S5), so the renderer is built with clipboard writes (OSC 52) off
   *  and only web links openable. Read once, when the pane mounts — it must be
   *  settled before the first byte. */
  untrusted?: boolean;
  backend?: TerminalBackend;
  createRenderer?: (opts: { untrusted: boolean }) => TerminalRenderer;
}

/** How long a resize burst has to be quiet before the new grid is sent to the
 *  PTY. Only the SIGWINCH waits — the renderer refits on every observer tick. */
const SIGWINCH_SETTLE_MS = 100;

function safeFit(renderer: TerminalRenderer): { cols: number; rows: number } {
  try {
    const size = renderer.fit();
    if (size.cols > 0 && size.rows > 0) return size;
  } catch {
    // element not sized yet
  }
  return { cols: 80, rows: 24 };
}

/** How long a pane waits on its host before it says the terminals aren't answering. */
export const UNANSWERED_MS = 10_000;

export function TerminalView({
  cwd,
  command = "",
  args,
  label,
  agentKind = null,
  untrusted = false,
  adoptId,
  seed,
  active = true,
  focused = active,
  onExit,
  onClose,
  onResume,
  resumeBlocked,
  unansweredHint,
  onLink,
  onReady,
  backend = tauriBackend,
  createRenderer = (opts) => new XtermRenderer(opts),
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  // Whether the session is reachable right now. Only a remote session (Daedalus,
  // or the local santree server) ever says otherwise, and `reconnecting` is never
  // an exit: the process is still running there, and the backend catches this pane
  // up when the link is back. `lost` is not an exit either: the session is gone
  // without having ended (the server stopped, or the pane never got one), so the
  // sentinel that closes a tab never comes and the pane has to say so itself.
  const [link, setLink] = useState<PaneLink>("live");
  // Whether the session has not yet answered the open/attach that brings this
  // pane up. With `link === "reconnecting"` it is the other half of "waiting on
  // the host", and either one lasting too long shows the hint below.
  const [starting, setStarting] = useState(true);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const idRef = useRef<SessionId | null>(null);
  // The session this pane started, as a promise, so a re-run of the mount effect
  // joins the one already in flight rather than racing it. Deliberately not
  // cleared on cleanup — it outlives the effect and dies with the component,
  // which is exactly when nothing needs it any more.
  const startRef = useRef<Promise<SessionId> | null>(null);
  // Whether this pane's session has already been sent its seed. Tied to the
  // session, not to a run of the effect: the run that *creates* the session can
  // be torn down before its `open` resolves (StrictMode does this every time),
  // and a seed keyed to that run would then never be sent at all.
  const seededRef = useRef(false);
  // Last grid size sent to the PTY. Resizing the PTY makes the shell redraw its
  // prompt (p10k/zsh reprint on SIGWINCH), so we only send a resize when cols/rows
  // *actually* change — a ResizeObserver fires on every pixel nudge (e.g. toggling
  // the side panel re-lays-out the host), and most of those keep the same grid.
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  // Read the latest onExit without re-running the mount-once effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onLinkRef = useRef(onLink);
  onLinkRef.current = onLink;
  // Same, for `active`: every pane stays laid out at full size (see TerminalLayer),
  // so a geometry change to the shared layer resizes ALL of them at once. Only the
  // pane on screen may act on that — a SIGWINCH to a backgrounded shell makes it
  // reprint its prompt, and those blank prompt lines pile up unseen. A hidden pane
  // catches up in the activation effect below, which refits when it comes back.
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // Send a resize to the PTY only if the grid size changed since the last send.
  const commitResize = useCallback(
    (cols: number, rows: number) => {
      if (idRef.current === null || cols <= 0 || rows <= 0) return;
      if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return;
      lastSizeRef.current = { cols, rows };
      backend.resize(idRef.current, cols, rows);
    },
    [backend],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: open exactly one session for this pane's lifetime; props are stable per tab.
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const renderer = createRenderer({ untrusted });
    rendererRef.current = renderer;
    renderer.mount(el);
    // Passive and display-only: a coding CLI animates its OSC title while it
    // works, and that is the sidebar's fallback status signal for when hook
    // events go quiet. Registered before the session is opened or adopted so a
    // replayed backlog's titles are caught too. Read `agentTitle.ts` before
    // using this for anything else — the title must never reach a PTY write.
    renderer.onTitle((title) => setSessionTitle(paneAddress(label, agentKind), title));

    let unregisterPane: (() => void) | undefined;
    let disposed = false;
    const { cols, rows } = safeFit(renderer);
    const handlers = {
      onOutput: (bytes: Uint8Array) => renderer.write(bytes),
      onExit: () => onExitRef.current?.(),
      onLink: (next: PaneLink) => {
        if (disposed) return;
        setLink(next);
        onLinkRef.current?.(next);
      },
    };

    (async () => {
      try {
        // Whether this run is the one that starts the session, decided *before*
        // anything is awaited.
        //
        // React re-runs an effect without unmounting — StrictMode does it on
        // every mount in development — and since the cleanup only detaches, a
        // second run that opened again would strand the first session with
        // nothing pointing at it. Guarding on the resolved id is not enough:
        // `open` is async, so both runs would be past the check before either
        // returned. The in-flight promise is the thing that has to be shared.
        const created = startRef.current === null && adoptId === undefined;
        if (created) {
          startRef.current = backend.open(
            { cwd, command, args: args ?? [], cols, rows, label, agentKind },
            handlers,
          );
        } else if (startRef.current === null && adoptId !== undefined) {
          // Adopting is not a cheaper open — it is the opposite operation. The
          // process is already running and has already printed; what this pane
          // needs is the backlog, not a fresh shell and a re-run seed.
          startRef.current = Promise.resolve(adoptId);
        }
        let id: SessionId;
        try {
          id = await (startRef.current as Promise<SessionId>);
        } catch (e) {
          // A failed start must not latch: leaving the rejected promise here
          // would make every later run re-throw it instead of retrying.
          startRef.current = null;
          throw e;
        }
        if (disposed) {
          // Nothing to undo. A session this run opened stays in `startRef`, so
          // the next run of this effect finds it instead of opening a second;
          // one that was inherited was never ours to end.
          return;
        }
        if (!created) {
          // `fresh`, not `unknown`: this xterm was just constructed, so it has
          // nothing on it that a replay could duplicate. The terminal modes the
          // program set before the retained tail come from the host, ahead of
          // the replay.
          await backend.attach(id, { kind: "fresh" }, handlers);
          if (disposed) return;
        }
        idRef.current = id;
        setStarting(false);
        lastSizeRef.current = { cols, rows };
        renderer.onInput((data) => backend.write(id, data));
        unregisterPane = onReadyRef.current?.({ end: () => backend.close(id) });
        // Seeding an adopted session would type the launch command into a shell
        // that is already running the agent it names — `adoptId` is the test,
        // not `created`, because a session this pane opened still needs its seed
        // no matter which run of the effect ends up delivering it.
        //
        // It goes through `seed`, not `write`: the backend has to know this line
        // is santree's and not the user's, because a launch command can outgrow
        // what a tty accepts on one line and has to be spilled to a script,
        // while a keystroke — a long paste included — must always arrive
        // verbatim. See `terminal_seed` in `terminal.rs`.
        if (seed && adoptId === undefined && !seededRef.current) {
          seededRef.current = true;
          backend.seed(id, seed);
        }
        if (focusedRef.current) renderer.focus();
      } catch (e) {
        // The pane can close while `open` is still in flight; writing to a disposed
        // renderer throws, and there'd be no one left to show the message to anyway.
        if (disposed) return;
        setStarting(false);
        renderer.write(`\r\n\x1b[31m[failed to start terminal: ${String(e)}]\x1b[0m\r\n`);
      }
    })();

    const stopObserving = observeResize(el, renderer, activeRef, commitResize);

    return () => {
      disposed = true;
      stopObserving();
      unregisterPane?.();
      // Detach, never close. A pane unmounting says nothing about whether the
      // work in it should stop — the user switched tabs, or the window
      // reloaded. Ending the session is an explicit act, and it happens in
      // `close(key)` on the tab, not here. This one line is the difference
      // between a reload costing you the view and costing you the work.
      if (idRef.current !== null) backend.detach(idRef.current);
      // The title outlives nothing: this pane going away is the only moment
      // santree stops hearing from the process, so a title left behind would
      // report "working" forever with nothing able to correct it.
      clearSessionTitle(paneAddress(label, agentKind));
      renderer.dispose();
      rendererRef.current = null;
      // `idRef` deliberately survives: if this effect runs again on the same
      // pane, that is the only record of the session it already started, and
      // clearing it here would open a second one and strand the first. It dies
      // with the component, which is the point at which nothing needs it.
    };
  }, []);

  // After UNANSWERED_MS of waiting on the host (a link that is down, or a session
  // that has not opened), say so. A timer on the link state santree already holds:
  // nothing reads or probes the PTY, and the hint never writes to it. A `lost`
  // pane is not waiting, it has its own message.
  const waiting = link !== "lost" && (link === "reconnecting" || starting);
  const unanswered = useHeldFor(waiting, UNANSWERED_MS);

  // Refit when this pane comes on screen (it may have been sized to zero while
  // hidden behind another tab), and take the keyboard when it is the one being
  // worked in.
  useEffect(() => {
    if (!active) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const raf = requestAnimationFrame(() => {
      const { cols, rows } = safeFit(renderer);
      commitResize(cols, rows);
      if (focused) renderer.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, focused, commitResize]);

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      <WaitingBadge
        reconnecting={link === "reconnecting"}
        unanswered={unanswered}
        hint={unansweredHint}
      />
      {link === "lost" && (
        <LostSession onClose={onClose} onResume={onResume} resumeBlocked={resumeBlocked} />
      )}
    </div>
  );
}

/**
 * Keep the grid fitted to the pane's box, and the PTY told of the new size once
 * a resize settles. Only the pane on screen acts (`activeRef`; see its comment).
 * Returns the disposer.
 */
function observeResize(
  el: HTMLElement,
  renderer: TerminalRenderer,
  activeRef: { readonly current: boolean },
  commitResize: (cols: number, rows: number) => void,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  let sigwinch: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    if (!activeRef.current) return;
    // Fit IMMEDIATELY, in the same frame the box changed. xterm sizes
    // `.xterm-screen` and its canvases from the grid, not from the element it
    // was mounted in, and nothing in its stylesheet clips them — so a grid that
    // lags a shrinking box is a canvas painting over whatever sits beside the
    // pane. (The layer clips too; this is the other half, so what survives the
    // clip is also the right picture.) A fit is local work — it never touches
    // the PTY — and `FitAddon.fit()` no-ops unless cols/rows actually changed, so
    // the cost of doing it per tick is some extra repaints during a drag. That
    // trade is deliberate.
    const { cols, rows } = safeFit(renderer);
    // The PTY resize is the half that stays debounced, and it is the half the
    // debounce was always for: every SIGWINCH makes the shell reprint its prompt
    // (p10k especially), so one per frame of a drag stacks a prompt line per
    // frame. Wait for the size to SETTLE and send exactly one — `commitResize`
    // then drops even that when the grid didn't change.
    if (sigwinch) clearTimeout(sigwinch);
    sigwinch = setTimeout(() => {
      if (!activeRef.current) return;
      commitResize(cols, rows);
    }, SIGWINCH_SETTLE_MS);
  });
  ro.observe(el);
  return () => {
    ro.disconnect();
    if (sigwinch) clearTimeout(sigwinch);
  };
}
