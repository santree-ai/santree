/** Triage's main tab bar: the ticket, the investigations open beside it and the
 *  ticket's own tabs, on the same {@link TabStrip} Trees and Reviews draw.
 *
 *  **The first tab is the workspace itself.** "Linear" is the ticket — not a
 *  stored row, so it always exists and carries no close ×. Everything after it
 *  closes like any other tab: an investigation's ✕ ends the process and forgets
 *  the stored session (the transcript on disk is what lets Session history
 *  reopen it), and a row's ✕ ends its process and drops the row — the same
 *  `worktree_tabs` rows, closed by the same rule (`useTabSessions`), that the
 *  other two strips draw.
 *
 *  The "+" opens the ticket's own tabs — a Codex or Claude Code session to ask
 *  things in, or a terminal, as many as you like — gated on each provider being
 *  signed in, because a row that opened a pane the provider would immediately
 *  refuse is worse than a disabled one that says why. It never opens an
 *  investigation: that is the ticket page's action, one per provider, and the
 *  strip is not where the ticket is read. Every row runs on the ticket's
 *  attached project; the model this bar is handed is already gated on there
 *  being one (see `TriageView`), so nothing here asks.
 *
 *  The trailing cluster is not part of the tablist: the right rail's expand
 *  control, here only while the rail is hidden — the same hand-off Trees and
 *  Reviews make, so the button stays put across the toggle. */
import type { AgentKind, TabKind, TriageTicket } from "../../bindings";
import { AgentIcon, LinearLogo, TerminalIcon } from "../../components/icons";
import { MENU_ITEM } from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { type StripTab, TabStrip } from "../../components/TabStrip";
import { useAgentAuth, useCodexAccount, useCodexHealth } from "../../lib/queries";
import { useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { liveTabFor } from "../agents/registry";
import { agentProvider } from "../terminal/agentProvider";
import { useTerminals } from "../terminal/TerminalsContext";
import { useTabSessions } from "../trees/useTabSessions";
import { triageTermKey } from "./providerSessions";
import { agentTab, rowTab, type TriageMainTab, type TriageTabs } from "./useTriageTabs";

export function TriageTabBar({
  ticket,
  tabs,
  rightCollapsed,
  onToggleRight,
}: {
  ticket: TriageTicket;
  tabs: TriageTabs;
  rightCollapsed: boolean;
  onToggleRight: () => void;
}) {
  const termKey = triageTermKey(ticket.id);
  // A tab is its process, so the ✕ ends the PTY before the tab is forgotten.
  // The rows get that from `useTabSessions`, exactly as a worktree's do; an
  // investigation hangs off the ticket's own surface rather than a row, which
  // is the only reason the same hook can't do it for those too.
  const { closeWithSession } = useTabSessions(termKey, tabs.rows, tabs.closeTab);
  const { tabs: sessions, close: endSession } = useTerminals();
  const closeAgent = (agent: AgentKind) => {
    const live = liveTabFor(termKey, agent, sessions);
    if (live) endSession(live.key);
    tabs.closeAgent(agent);
  };

  const items: StripTab<TriageMainTab>[] = [
    { tab: "linear", label: "Linear", icon: <LinearLogo size={11} className="text-muted-3" /> },
    ...tabs.providers.map((agent) => ({
      tab: agentTab(agent),
      label: agentProvider(agent).label,
      icon: <AgentIcon kind={agent} size={11} className="text-muted-3" />,
      onClose: () => closeAgent(agent),
    })),
    ...tabs.rows.map((t) => ({
      tab: rowTab(t.id),
      label: t.title,
      icon:
        t.kind === "terminal" ? (
          <TerminalIcon size={11} className="text-muted-3" />
        ) : (
          <AgentIcon kind={t.agentKind ?? "Claude"} size={11} className="text-muted-3" />
        ),
      onClose: () => closeWithSession(t),
      onRename: (title: string) => tabs.renameTab(t.id, title),
    })),
  ];

  return (
    <TabStrip
      tabs={items}
      active={tabs.active}
      onSelect={tabs.select}
      ariaLabel="Ticket tabs"
      newTabMenu={(close) => <NewTabMenu onAdd={tabs.addTab} close={close} />}
      newTabMenuClassName="w-40 overflow-hidden"
      trailing={rightCollapsed ? <PanelToggle collapsed onToggle={onToggleRight} /> : null}
    />
  );
}

/** New-tab menu rows: a new Codex or Claude Code session, or a terminal — the
 *  same three Trees offers, in the same order, so the digits mean the same
 *  thing on every strip (1 → Codex, 2 → Claude Code, 3 → Terminal). Mounted only
 *  while the menu is open, so its digit-key listener is live exactly when the
 *  menu is visible. */
function NewTabMenu({
  onAdd,
  close,
}: {
  onAdd: (kind: TabKind, agentKind?: AgentKind) => void;
  close: () => void;
}) {
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth().data;
  const codexAccount = useCodexAccount(codexHealth?.available === true).data;
  const codexReady = !!codexHealth?.available && !!codexAccount?.connected;
  const ready = (agent: AgentKind) => (agent === "Codex" ? codexReady : claudeReady);

  const add = (kind: TabKind, agentKind?: AgentKind) => {
    if (agentKind && !ready(agentKind)) return;
    if (agentKind) onAdd(kind, agentKind);
    else onAdd(kind);
    close();
  };

  useDigitShortcuts([
    () => add("agent", "Codex"),
    () => add("agent", "Claude"),
    () => add("terminal"),
  ]);

  return (
    <>
      {(["Codex", "Claude"] as const).map((agent, i) => (
        <button
          key={agent}
          type="button"
          disabled={!ready(agent)}
          // The row is a session of that provider, and the name says so.
          aria-label={`Open a ${agentProvider(agent).label} session`}
          title={
            ready(agent) ? undefined : `Connect ${agentProvider(agent).label} in Settings first`
          }
          onClick={() => add("agent", agent)}
          className={MENU_ITEM}
        >
          <AgentIcon kind={agent} size={13} />
          {agentProvider(agent).label}
          <span className="ml-auto text-[10px] text-muted-4">{i + 1}</span>
        </button>
      ))}
      <button
        type="button"
        aria-label="Open a terminal"
        title="A login shell on the project's main checkout"
        onClick={() => add("terminal")}
        className={MENU_ITEM}
      >
        <TerminalIcon size={13} />
        Terminal
        <span className="ml-auto text-[10px] text-muted-4">3</span>
      </button>
    </>
  );
}
