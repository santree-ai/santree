/**
 * Wires a `TerminalRenderer` to a `TerminalBackend` for one PTY session:
 * opens the session, streams PTY output → renderer, renderer keystrokes → PTY,
 * keeps the PTY grid in sync with the visible size, and tears everything down on
 * unmount. Backend and renderer are injectable so the wiring is unit-testable
 * with fakes. No xterm import here — only the `TerminalRenderer` interface.
 */
import { useCallback, useEffect, useRef } from "react";

import { tauriBackend } from "./TauriBackend";
import type { SessionId, TerminalBackend, TerminalRenderer, Unsubscribe } from "./types";
import { XtermRenderer } from "./XtermRenderer";

export interface TerminalViewProps {
  cwd?: string;
  /** Empty ⇒ the user's login shell. */
  command?: string;
  args?: string[];
  /** Optional initial input, sent as if typed (followed by Enter). */
  seed?: string;
  /** When this pane is the visible one — refit + focus on activation. */
  active?: boolean;
  /** Called once when the hosted process exits (so the tab can be torn down). */
  onExit?: () => void;
  backend?: TerminalBackend;
  createRenderer?: () => TerminalRenderer;
}

function safeFit(renderer: TerminalRenderer): { cols: number; rows: number } {
  try {
    const size = renderer.fit();
    if (size.cols > 0 && size.rows > 0) return size;
  } catch {
    // element not sized yet
  }
  return { cols: 80, rows: 24 };
}

export function TerminalView({
  cwd,
  command = "",
  args,
  seed,
  active = true,
  onExit,
  backend = tauriBackend,
  createRenderer = () => new XtermRenderer(),
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const idRef = useRef<SessionId | null>(null);
  // Last grid size sent to the PTY. Resizing the PTY makes the shell redraw its
  // prompt (p10k/zsh reprint on SIGWINCH), so we only send a resize when cols/rows
  // *actually* change — a ResizeObserver fires on every pixel nudge (e.g. toggling
  // the side panel re-lays-out the host), and most of those keep the same grid.
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  // Read the latest onExit without re-running the mount-once effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Same, for `active`: every pane stays laid out at full size (see TerminalLayer),
  // so a geometry change to the shared layer resizes ALL of them at once. Only the
  // pane on screen may act on that — a SIGWINCH to a backgrounded shell makes it
  // reprint its prompt, and those blank prompt lines pile up unseen. A hidden pane
  // catches up in the activation effect below, which refits when it comes back.
  const activeRef = useRef(active);
  activeRef.current = active;

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

    const renderer = createRenderer();
    rendererRef.current = renderer;
    renderer.mount(el);

    let unsub: Unsubscribe = () => {};
    let unsubExit: Unsubscribe = () => {};
    let disposed = false;
    const { cols, rows } = safeFit(renderer);

    (async () => {
      try {
        const id = await backend.open({
          cwd,
          command,
          args: args ?? [],
          cols,
          rows,
        });
        if (disposed) {
          backend.close(id);
          return;
        }
        idRef.current = id;
        lastSizeRef.current = { cols, rows };
        unsub = backend.onOutput(id, (bytes) => renderer.write(bytes));
        unsubExit = backend.onExit(id, () => onExitRef.current?.());
        renderer.onInput((data) => backend.write(id, data));
        if (seed) backend.write(id, seed.endsWith("\r") ? seed : `${seed}\r`);
        renderer.focus();
      } catch (e) {
        // The pane can close while `open` is still in flight; writing to a disposed
        // renderer throws, and there'd be no one left to show the message to anyway.
        if (disposed) return;
        renderer.write(`\r\n\x1b[31m[failed to start terminal: ${String(e)}]\x1b[0m\r\n`);
      }
    })();

    let ro: ResizeObserver | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (!activeRef.current) return;
        // DEBOUNCE the resize — don't fit/resize on every observer tick. A window or
        // panel resize fires a burst of ticks, each a slightly different size; sending
        // a SIGWINCH per intermediate size makes the shell redraw its prompt over and
        // over (xterm's reflow shifts the cursor between rapid resizes, so each redraw
        // stacks a new prompt line). Waiting for the size to SETTLE and resizing once
        // gives a single clean in-place redraw — the same approach VS Code uses.
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!activeRef.current) return;
          const { cols, rows } = safeFit(renderer);
          commitResize(cols, rows);
        }, 100);
      });
      ro.observe(el);
    }

    return () => {
      disposed = true;
      ro?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      unsub();
      unsubExit();
      if (idRef.current !== null) backend.close(idRef.current);
      renderer.dispose();
      rendererRef.current = null;
      idRef.current = null;
    };
  }, []);

  // Refit + focus when this pane becomes the active one (it may have been sized
  // to zero while hidden behind another tab).
  useEffect(() => {
    if (!active) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const raf = requestAnimationFrame(() => {
      const { cols, rows } = safeFit(renderer);
      commitResize(cols, rows);
      renderer.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, commitResize]);

  return <div ref={host} className="h-full w-full" />;
}
