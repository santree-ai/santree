/**
 * The Triage workspace's window management: which tab is showing, which
 * investigation tabs a ticket has, and the tabs opened beside them.
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
 *   opened are the same tab. Opened from the ticket page (and ⌘I), never from
 *   the "+": an investigation is the ticket's, one per provider.
 * - **`tab:<id>`** — the ticket's own tabs: a plain agent session to ask things
 *   in, or a shell, as many as you like. `worktree_tabs` rows, exactly the ones
 *   Trees and Reviews draw for a worktree, hanging off the ticket's surface key
 *   (`triage:<ticket>`) instead — same rows, same persistence, so a restart
 *   brings them back and an agent tab resumes its conversation. What the "+"
 *   opens.
 *
 * Everything here runs on the ticket's attached project (see `TriageView` and
 * `useTriageRepo`), and both the stored investigations and the rows are read
 * under that repo — `terminal_sessions.repo` and `worktree_tabs.repo` are
 * written with it, so a lookup through any other repo finds nothing. Whether the
 * ticket *has* a project is not this hook's question: it is window management,
 * and the gate that asks lives where the actions are wired.
 */
import { useCallback, useMemo, useState } from "react";

import type { AgentKind, TabKind, WorktreeTab } from "../../bindings";
import {
  useAddWorktreeTab,
  useCloseInvestigationSession,
  useRemoveWorktreeTab,
  useRenameWorktreeTab,
  useStartedInvestigations,
  useWorktreeTabs,
} from "../../lib/queries";
import { useTerminals } from "../terminal/TerminalsContext";
import { defaultTabTitle } from "../trees/model";
import { INTERACTIVE_AGENTS, orderedProviders, triageTermKey } from "./providerSessions";

export type TriageMainTab = "linear" | `agent:${AgentKind}` | `tab:${string}`;

/** The main-tab id for one provider's investigation, and for one of the
 *  ticket's own rows. */
export const agentTab = (agent: AgentKind): TriageMainTab => `agent:${agent}`;
export const rowTab = (id: string): TriageMainTab => `tab:${id}`;

/** Which investigation a tab is, or `null` for the ticket and the rows. */
export function agentTabKind(tab: TriageMainTab): AgentKind | null {
  if (!tab.startsWith("agent:")) return null;
  const agent = tab.slice("agent:".length) as AgentKind;
  return INTERACTIVE_AGENTS.includes(agent) ? agent : null;
}

/** Which row a tab is, or `null` for the ticket and the investigations. */
export function rowTabId(tab: TriageMainTab): string | null {
  return tab.startsWith("tab:") ? tab.slice("tab:".length) : null;
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
  /** The ticket's own `worktree_tabs` rows, in strip order. */
  rows: WorktreeTab[];
  /** Open a new row and show it; its pane spawns on mount. */
  addTab: (kind: TabKind, agentKind?: AgentKind) => void;
  /** Drop a row. The strip ends the PTY, as for every closable tab; the backend
   *  forgets an agent row's stored session with it. */
  closeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
}

export function useTriageTabs(repo: string, ticketId: string): TriageTabs {
  const termKey = triageTermKey(ticketId);
  const { data: stored = [] } = useStartedInvestigations(repo);
  const { tabs: terminals } = useTerminals();
  const { mutate: closeSession } = useCloseInvestigationSession(repo);
  // The rows hang off the ticket's surface key, which is what `worktree_tabs`
  // stores as their owner and what their term keys are built from.
  const { data: allTabs = [] } = useWorktreeTabs(repo);
  const { mutate: addTabRow } = useAddWorktreeTab(repo);
  const { mutate: renameTabRow } = useRenameWorktreeTab(repo);
  const { mutate: removeTabRow } = useRemoveWorktreeTab(repo);
  const [mounted, setMounted] = useState<AgentKind[]>([]);
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
  const rows = useMemo(() => allTabs.filter((t) => t.worktreeId === termKey), [allTabs, termKey]);

  // The remembered tab resolved against what is actually open — one rule for
  // "what am I looking at", so closing a tab needs no fallback of its own.
  const open: TriageMainTab[] = [
    "linear",
    ...providers.map(agentTab),
    ...rows.map((t) => rowTab(t.id)),
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

  const addTab = useCallback(
    (kind: TabKind, agentKind?: AgentKind) => {
      // No project, no row: there is no directory to run in, and no repo to
      // store the row under. The gate in `TriageView` asks first, so this is
      // only the guard behind it.
      if (!repo) return;
      // The id is minted here (not by the backend) so the optimistic cache patch
      // is the exact row the DB will hold and the tab can be focused immediately.
      const id = crypto.randomUUID();
      const resolvedAgent = kind === "terminal" ? null : (agentKind ?? "Codex");
      addTabRow({
        id,
        worktreeId: termKey,
        kind,
        agentKind: resolvedAgent,
        title: defaultTabTitle(kind, resolvedAgent, rows),
        pr: null,
      });
      setRemembered(rowTab(id));
    },
    [repo, termKey, rows, addTabRow],
  );

  const closeTab = useCallback(
    (id: string) => {
      setRemembered((current) => (current === rowTab(id) ? null : current));
      removeTabRow(id);
    },
    [removeTabRow],
  );

  const renameTab = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (trimmed) renameTabRow({ id, title: trimmed });
    },
    [renameTabRow],
  );

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
    rows,
    addTab,
    closeTab,
    renameTab,
  };
}
