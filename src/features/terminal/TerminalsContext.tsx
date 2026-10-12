/**
 * App-global terminal session state. Lifting this out of the route keeps shells
 * alive across tab switches (switching away must never kill a running process)
 * and lets the nav tab show a live count. The sessions are rendered once, in a
 * persistent layer (see `TerminalLayer`), regardless of the active route.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

import type { AdoptedSession } from "../../bindings";
import { adoptedMap } from "./adoptedTabs";
import { fixtureTerminalSpecs } from "./fixtureSeam";
import { type TerminalTabs, useTerminalTabs } from "./orchestrator";
import { PAGE_OWNER } from "./pageOwner";
import { tauriBackend } from "./TauriBackend";
import type { SessionId } from "./types";

const TerminalsContext = createContext<TerminalTabs | null>(null);

/**
 * Live sessions this page inherited from the last one, by pane address
 * (`paneAddress`: the surface's `term_key` and the provider running in it —
 * one surface can have a pane per provider, and both must find their own).
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
  /** Every session adopted so far, in full, for the tabs they have not got yet
   *  (see `adoptedTabs`). Grows when a server that came up late is adopted. */
  panes: AdoptedSession[];
  ready: boolean;
}

const EMPTY: Adopted = { sessions: new Map(), panes: [], ready: false };

const AdoptedContext = createContext<Adopted>(EMPTY);
const AdoptAgainContext = createContext<() => Promise<void>>(async () => {});

export function TerminalsProvider({ children }: { children: ReactNode }) {
  // Empty outside the dev screenshot fixture mode — see `fixtureSeam.ts`.
  const value = useTerminalTabs(fixtureTerminalSpecs());
  const { adopted, adoptAgain } = useAdoptSessions();
  return (
    <AdoptedContext.Provider value={adopted}>
      <AdoptAgainContext.Provider value={adoptAgain}>
        <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>
      </AdoptAgainContext.Provider>
    </AdoptedContext.Provider>
  );
}

/**
 * The adoption of a previous page load's sessions, run once per document — and
 * again, on request, when a server that was not up yet comes up.
 *
 * Module scope for the same reason `PAGE_OWNER` is: this is a property of the
 * page load, not of a component, and the first run must happen exactly once.
 * Adoption is also *not* idempotent from the caller's side — it re-tags what it
 * returns, so a second call finds every session already claimed and answers with
 * nothing. Run from an effect, React's double-invoke would do exactly that and
 * hand the empty second answer to the panes, which would then each spawn a
 * duplicate of the session still running behind it.
 *
 * That same property is what makes the *later* runs safe: a re-run answers only
 * with sessions this page has not claimed, so it can neither steal a held pane
 * nor adopt one twice. They are queued behind each other and the first, though,
 * because two in flight at once could both see the same session as unclaimed.
 *
 * Best effort, and deliberately silent on failure: the worst outcome is the
 * status quo before this existed (panes spawn fresh sessions), which is never
 * worth a toast or an unhandled rejection. The call also simply isn't there
 * outside Tauri — tests, a browser preview — so this must tolerate the binding
 * rejecting outright.
 */
let adoption: Promise<AdoptedSession[]> | null = null;
let adoptChain: Promise<unknown> = Promise.resolve();

function enqueueAdoption(): Promise<AdoptedSession[]> {
  const run = adoptChain.then(() => tauriBackend.adoptSessions(PAGE_OWNER).catch(() => []));
  adoptChain = run;
  return run;
}

function adoptOnce(): Promise<AdoptedSession[]> {
  adoption ??= enqueueAdoption();
  return adoption;
}

/** Forget the per-document adoption, so a test can play a page load again. */
export function resetAdoption(): void {
  adoption = null;
  adoptChain = Promise.resolve();
}

/** Fold newly adopted sessions into what is held. Idempotent per session id. */
function merge(held: Adopted, found: AdoptedSession[]): Adopted {
  const fresh = found.filter((s) => !held.panes.some((p) => p.id === s.id));
  if (fresh.length === 0 && held.ready) return held;
  return {
    sessions: new Map([...held.sessions, ...adoptedMap(fresh)]),
    panes: [...held.panes, ...fresh],
    ready: true,
  };
}

function useAdoptSessions(): { adopted: Adopted; adoptAgain: () => Promise<void> } {
  const [adopted, setAdopted] = useState<Adopted>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    adoptOnce().then((found) => {
      if (!cancelled) setAdopted((held) => merge(held, found));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Not cancellable by an unmount: the provider lives for the document, and a
  // claim already made in the backend must reach the panes that will want it.
  const adoptAgain = useCallback(async () => {
    const found = await enqueueAdoption();
    setAdopted((held) => merge(held, found));
  }, []);
  return { adopted, adoptAgain };
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

/** Adopt again: for a server that came up after the page-load adoption gave up
 *  waiting for it. Never closes or replaces anything — see {@link adoptOnce}. */
export function useAdoptAgain(): () => Promise<void> {
  return useContext(AdoptAgainContext);
}
