/**
 * Wires a `TerminalRenderer` to a `TerminalBackend` for one PTY session:
 * opens the session, streams PTY output → renderer, renderer keystrokes → PTY,
 * keeps the PTY grid in sync with the visible size, and tears everything down on
 * unmount. Backend and renderer are injectable so the wiring is unit-testable
 * with fakes. No xterm import here — only the `TerminalRenderer` interface.
 */
import { useEffect, useRef } from "react";

import { tauriBackend } from "./TauriBackend";
import type { SessionId, TerminalBackend, TerminalRenderer, Unsubscribe } from "./types";
import { XtermRenderer } from "./XtermRenderer";

export interface TerminalViewProps {
  cwd?: string;
  /** Empty ⇒ the user's login shell. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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
  env,
  seed,
  active = true,
  onExit,
  backend = tauriBackend,
  createRenderer = () => new XtermRenderer(),
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<TerminalRenderer | null>(null);
  const idRef = useRef<SessionId | null>(null);
  // Read the latest onExit without re-running the mount-once effect.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

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
          env: env ?? {},
          cols,
          rows,
        });
        if (disposed) {
          backend.close(id);
          return;
        }
        idRef.current = id;
        unsub = backend.onOutput(id, (bytes) => renderer.write(bytes));
        unsubExit = backend.onExit(id, () => onExitRef.current?.());
        renderer.onInput((data) => backend.write(id, data));
        if (seed) backend.write(id, seed.endsWith("\r") ? seed : `${seed}\r`);
        renderer.focus();
      } catch (e) {
        renderer.write(`\r\n\x1b[31m[failed to start terminal: ${String(e)}]\x1b[0m\r\n`);
      }
    })();

    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        const size = safeFit(renderer);
        if (idRef.current !== null && size.cols > 0) {
          backend.resize(idRef.current, size.cols, size.rows);
        }
      });
      ro.observe(el);
    }

    return () => {
      disposed = true;
      ro?.disconnect();
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
      if (idRef.current !== null && cols > 0) backend.resize(idRef.current, cols, rows);
      renderer.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, backend]);

  return <div ref={host} className="h-full w-full" />;
}
