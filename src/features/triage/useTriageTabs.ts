/**
 * The Triage workspace's window management: which tab is showing, and which
 * investigation tabs a ticket has.
 *
 * Three kinds of tab, and the asymmetry between them is the whole model:
 *
 * - **`linear`** — the ticket itself. Not a stored row and never closable: it
 *   is what this workspace *is*, the way "Pull Request" is what Reviews is, so
 *   there is always something to fall back to when an agent tab goes.
 * - **`agent:<kind>`** — one provider's investigation of the ticket. It exists
 *   while a stored session says the provider has investigated this ticket
 *   (across restarts), while a PTY for it is live, or once it has been opened
 *   here — the union, so a tab a restart brought back and a tab you just
 *   opened are the same tab.
 * - **`shell`** — a plain login shell on the attached project's main checkout.
 *   Live or opened here, never stored: nothing durable describes a shell, so
 *   a restart does not bring one back. One per ticket, on the same surface
 *   key as the investigations; the provider being *absent* is what tells its
 *   pane apart from theirs.
 *
 * Everything here runs on the ticket's attached project (see `TriageView` and
 * `useTriageRepo`), and the stored investigations are read under that repo —
 * `terminal_sessions.repo` is written under it, so a lookup through any other
 * repo finds nothing. Whether the ticket *has* a project is not this hook's
 * question: it is window management, and the gate that asks lives where the
 * actions are wired.
 */
import { useCallback, useMemo, useState } from "react";

import type { AgentKind } from "../../bindings";
import { useCloseInvestigationSession, useStartedInvestigations } from "../../lib/queries";
import type { TerminalTab } from "../terminal/orchestrator";
import { useTerminals } from "../terminal/TerminalsContext";
import { INTERACTIVE_AGENTS, orderedProviders, triageTermKey } from "./providerSessions";

export type TriageMainTab = "linear" | "shell" | `agent:${AgentKind}`;

/** The main-tab id for one provider's investigation. */
export const agentTab = (agent: AgentKind): TriageMainTab => `agent:${agent}`;

/** Which investigation a tab is, or `null` for the ticket and shell tabs. */
export function agentTabKind(tab: TriageMainTab): AgentKind | null {
  if (!tab.startsWith("agent:")) return null;
  const agent = tab.slice("agent:".length) as AgentKind;
  return INTERACTIVE_AGENTS.includes(agent) ? agent : null;
}

/** The ticket's plain shell, if one is live: the pane on this surface with no
 *  provider in it. `liveTabFor` requires a provider, so the two lookups cannot
 *  claim the same pane. */
export function liveShellFor(termKey: string, terminals: TerminalTab[]): TerminalTab | undefined {
  return terminals.find((t) => t.source === "triage" && t.refId === termKey && !t.agent);
}

export interface TriageTabs {
  /** The tab on screen. Always resolvable: `linear` is not a row, so it cannot
   *  be closed and there is always something to fall back to. */
  active: TriageMainTab;
  select: (tab: TriageMainTab) => void;
  /** Providers with an investigation tab, in menu order. */
  providers: AgentKind[];
  /** A past investigation by this provider is on disk, so its pane lands on the
   *  resume offer rather than auto-launching a fresh one. */
  hasStored: (agent: AgentKind) => boolean;
  /** Show a provider's tab, opening it if it isn't there. Showing a fresh one is
   *  also what *starts* it — the pane launches on mount. */
  openAgent: (agent: AgentKind) => void;
  /** Close a provider's tab: drop it here, forget the stored conversation. The
   *  strip ends the PTY — that half is its job for every closable tab. The
   *  transcript stays on disk, so Session history reopens the same investigation. */
  closeAgent: (agent: AgentKind) => void;
  /** The ticket has a shell tab — opened here, or a PTY for it is live. */
  hasShell: boolean;
  /** Show the shell tab, opening it if it isn't there; the pane spawns on mount. */
  openShell: () => void;
  /** Drop the shell tab. The strip ends the PTY, as for every closable tab. */
  closeShell: () => void;
}

export function useTriageTabs(repo: string, ticketId: string): TriageTabs {
  const termKey = triageTermKey(ticketId);
  const { data: stored = [] } = useStartedInvestigations(repo);
  const { tabs: terminals } = useTerminals();
  const { mutate: closeSession } = useCloseInvestigationSession(repo);
  const [mounted, setMounted] = useState<AgentKind[]>([]);
  const [shellMounted, setShellMounted] = useState(false);
  const [remembered, setRemembered] = useState<TriageMainTab | null>(null);

  // A stored row's `refId` is the bare ticket id: `started_investigations`
  // strips the `triage:` prefix on the way out. Matching it against the surface
  // key is how every stored tab silently failed to come back after a restart.
  const storedProviders = useMemo(
    () => stored.filter((s) => s.refId === ticketId).map((s) => s.agentKind),
    [stored, ticketId],
  );
  // A live pane is found by the pair — the surface's term key and the provider
  // in it — because one ticket can hold a pane per provider.
  const liveProviders = useMemo(
    () =>
      terminals.flatMap((t) =>
        t.source === "triage" && t.refId === termKey && t.agent ? [t.agent.kind] : [],
      ),
    [terminals, termKey],
  );
  const providers = useMemo(
    () => orderedProviders(new Set([...storedProviders, ...liveProviders, ...mounted])),
    [storedProviders, liveProviders, mounted],
  );
  const hasShell = shellMounted || liveShellFor(termKey, terminals) !== undefined;

  // The remembered tab resolved against what is actually open — one rule for
  // "what am I looking at", so closing a tab needs no fallback of its own.
  const open: TriageMainTab[] = [
    "linear",
    ...providers.map(agentTab),
    ...(hasShell ? (["shell"] as const) : []),
  ];
  const active = remembered && open.includes(remembered) ? remembered : "linear";

  const openAgent = useCallback((agent: AgentKind) => {
    setMounted((current) => (current.includes(agent) ? current : [...current, agent]));
    setRemembered(agentTab(agent));
  }, []);

  const closeAgent = useCallback(
    (agent: AgentKind) => {
      setMounted((current) => current.filter((a) => a !== agent));
      setRemembered((current) => (current === agentTab(agent) ? null : current));
      // The stored session goes too, or the strip puts the tab straight back on
      // the next launch from a conversation nothing is running.
      closeSession({ ticketId, agent });
    },
    [closeSession, ticketId],
  );

  const openShell = useCallback(() => {
    setShellMounted(true);
    setRemembered("shell");
  }, []);

  const closeShell = useCallback(() => {
    setShellMounted(false);
    setRemembered((current) => (current === "shell" ? null : current));
  }, []);

  const hasStored = useCallback(
    (agent: AgentKind) => storedProviders.includes(agent),
    [storedProviders],
  );

  return {
    active,
    select: setRemembered,
    providers,
    hasStored,
    openAgent,
    closeAgent,
    hasShell,
    openShell,
    closeShell,
  };
}
