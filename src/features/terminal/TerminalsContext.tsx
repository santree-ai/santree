/**
 * App-global terminal session state. Lifting this out of the route keeps shells
 * alive across tab switches (switching away must never kill a running process)
 * and lets the nav tab show a live count. The sessions are rendered once, in a
 * persistent layer (see `TerminalLayer`), regardless of the active route.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type TerminalTabs, useTerminalTabs } from "./orchestrator";
import { PAGE_OWNER } from "./pageOwner";
import { tauriBackend } from "./TauriBackend";
import type { SessionId } from "./types";

const TerminalsContext = createContext<TerminalTabs | null>(null);

/**
 * Live sessions this page inherited from the last one, by `term_key`.
 *
 * `ready` is load-bearing, not a loading flag. A pane consults this map exactly
 * once, as it mounts, and its mount effect never re-runs — so a pane that
 * mounted before the answer arrived has already spawned a *second* session for
 * work that was still running, and nothing will ever reconcile the two. The
 * layer therefore renders nothing until this is settled; it costs one IPC
 * round-trip of an invisible overlay, and it is the difference between a reload
 * adopting your agents and quietly duplicating them.
 */
interface Adopted {
  sessions: Map<string, SessionId>;
  ready: boolean;
}

const EMPTY: Adopted = { sessions: new Map(), ready: false };

const AdoptedContext = createContext<Adopted>(EMPTY);

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const value = useTerminalTabs();
  const adopted = useAdoptSessions();
  return (
    <AdoptedContext.Provider value={adopted}>
      <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>
    </AdoptedContext.Provider>
  );
}

/**
 * Claim the sessions a previous page load left running.
 *
 * Runs here because this provider is mounted once, at the root, for the life of
 * the document — the same lifetime the owner tag describes. It only ever claims
 * sessions tagged with a *different* owner, so a terminal this page opened can't
 * be caught by it, and re-tagging happens in the backend, which makes it safe to
 * run twice (StrictMode's double-mount does exactly that).
 *
 * A session nobody claims is deliberately left alone rather than reaped. The
 * only way to reach that state is a surface that vanished across a reload —
 * which cannot happen from the reload itself, since it changes nothing on disk —
 * so the cost is a shell that idles until the app exits, and the alternative is
 * killing work on a guess.
 */
/**
 * The adoption, run once per document.
 *
 * Module scope for the same reason `PAGE_OWNER` is: this is a property of the
 * page load, not of a component, and it must happen exactly once. Adoption is
 * also *not* idempotent from the caller's side — it re-tags what it returns, so
 * a second call finds every session already claimed and answers with nothing.
 * Run from an effect, React's double-invoke would do exactly that and hand the
 * empty second answer to the panes, which would then each spawn a duplicate of
 * the session still running behind it.
 *
 * Best effort, and deliberately silent on failure: the worst outcome is the
 * status quo before this existed (panes spawn fresh sessions), which is never
 * worth a toast or an unhandled rejection. The call also simply isn't there
 * outside Tauri — tests, a browser preview — so this must tolerate the binding
 * rejecting outright.
 */
let adoption: Promise<Map<string, SessionId>> | null = null;

function adoptOnce(): Promise<Map<string, SessionId>> {
  adoption ??= tauriBackend.adopt(PAGE_OWNER).catch(() => new Map<string, SessionId>());
  return adoption;
}

function useAdoptSessions(): Adopted {
  const [adopted, setAdopted] = useState<Adopted>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    adoptOnce().then((sessions) => {
      if (!cancelled) setAdopted({ sessions, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return adopted;
}

export function useTerminals(): TerminalTabs {
  const ctx = useContext(TerminalsContext);
  if (!ctx) throw new Error("useTerminals must be used within <TerminalsProvider>");
  return ctx;
}

/** The inherited sessions for this page load, and whether that is settled yet. */
export function useAdoptedSessions(): Adopted {
  return useContext(AdoptedContext);
}
