/** Triage's main tab bar: the ticket, the investigations open beside it and its
 *  shell, on the same {@link TabStrip} Trees and Reviews draw.
 *
 *  **The first tab is the workspace itself.** "Linear" is the ticket — not a
 *  stored row, so it always exists and carries no close ×. Everything after it
 *  closes like any other tab: an investigation's ✕ ends the process and forgets
 *  the stored session (the transcript on disk is what lets Session history
 *  reopen it), and the shell's ✕ ends its process, which is all a shell has.
 *
 *  The "+" offers the providers that don't have a tab yet, gated on each one
 *  being signed in — an investigation is a real CLI session, and a row that
 *  opened a pane the provider would immediately refuse is worse than a disabled
 *  one that says why — and then a terminal, when the ticket has none. Every row
 *  runs on the ticket's attached project; the model this bar is handed is
 *  already gated on there being one (see `TriageView`), so nothing here asks.
 *
 *  The trailing cluster is not part of the tablist: the right rail's expand
 *  control, here only while the rail is hidden — the same hand-off Trees and
 *  Reviews make, so the button stays put across the toggle. */
import type { AgentKind, TriageTicket } from "../../bindings";
import { AgentIcon, LinearLogo, TerminalIcon } from "../../components/icons";
import { MENU_ITEM } from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { type StripTab, TabStrip } from "../../components/TabStrip";
import { useAgentAuth, useCodexAccount, useCodexHealth } from "../../lib/queries";
import { useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { liveTabFor } from "../agents/registry";
import { agentProvider } from "../terminal/agentProvider";
import { useTerminals } from "../terminal/TerminalsContext";
import { INTERACTIVE_AGENTS, triageTermKey } from "./providerSessions";
import { agentTab, liveShellFor, type TriageMainTab, type TriageTabs } from "./useTriageTabs";

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
  // A tab is its process, so the ✕ ends the PTY before the tab is forgotten —
  // the strip's half of closing, as `useTabSessions` does for a worktree's rows
  // and `ReviewTabBar` for an AI review's.
  const { tabs: sessions, close: endSession } = useTerminals();
  const termKey = triageTermKey(ticket.id);
  const closeAgent = (agent: AgentKind) => {
    const live = liveTabFor(termKey, agent, sessions);
    if (live) endSession(live.key);
    tabs.closeAgent(agent);
  };
  const closeShell = () => {
    const live = liveShellFor(termKey, sessions);
    if (live) endSession(live.key);
    tabs.closeShell();
  };

  const items: StripTab<TriageMainTab>[] = [
    { tab: "linear", label: "Linear", icon: <LinearLogo size={11} className="text-muted-3" /> },
    ...tabs.providers.map((agent) => ({
      tab: agentTab(agent),
      label: agentProvider(agent).label,
      icon: <AgentIcon kind={agent} size={11} className="text-muted-3" />,
      onClose: () => closeAgent(agent),
    })),
    ...(tabs.hasShell
      ? [
          {
            tab: "shell" as const,
            label: "Terminal",
            icon: <TerminalIcon size={11} className="text-muted-3" />,
            onClose: closeShell,
          },
        ]
      : []),
  ];
  const addable = INTERACTIVE_AGENTS.filter((agent) => !tabs.providers.includes(agent));
  // Every provider has a tab and so does the shell: nothing to offer, so no "+".
  const canAdd = addable.length > 0 || !tabs.hasShell;

  return (
    <TabStrip
      tabs={items}
      active={tabs.active}
      onSelect={tabs.select}
      ariaLabel="Ticket tabs"
      newTabMenu={
        canAdd ? (close) => <NewTabMenu tabs={tabs} addable={addable} close={close} /> : undefined
      }
      trailing={rightCollapsed ? <PanelToggle collapsed onToggle={onToggleRight} /> : null}
    />
  );
}

/** New-tab menu rows. Mounted only while the menu is open, so its digit-key
 *  listener is live exactly when the menu is visible. */
function NewTabMenu({
  tabs,
  addable,
  close,
}: {
  tabs: TriageTabs;
  addable: AgentKind[];
  close: () => void;
}) {
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth().data;
  const codexAccount = useCodexAccount(codexHealth?.available === true).data;
  const codexReady = !!codexHealth?.available && !!codexAccount?.connected;
  const ready = (agent: AgentKind) => (agent === "Codex" ? codexReady : claudeReady);

  const investigate = (agent: AgentKind) => {
    if (!ready(agent)) return;
    tabs.openAgent(agent);
    close();
  };
  const openTerminal = () => {
    tabs.openShell();
    close();
  };

  // Digits follow the rows: the providers first, then the terminal.
  useDigitShortcuts([
    ...addable.map((agent) => (ready(agent) ? () => investigate(agent) : null)),
    ...(tabs.hasShell ? [] : [openTerminal]),
  ]);

  return (
    <>
      {addable.length > 0 && (
        <div className="px-3 pt-2 pb-1 font-mono text-[9px] tracking-[.06em] text-muted-4 uppercase">
          Investigate with
        </div>
      )}
      {addable.map((agent, i) => (
        <button
          key={agent}
          type="button"
          disabled={!ready(agent)}
          // The heading above is not read out, so the name carries the verb.
          aria-label={`Investigate with ${agentProvider(agent).label}`}
          title={
            ready(agent) ? undefined : `Connect ${agentProvider(agent).label} in Settings first`
          }
          onClick={() => investigate(agent)}
          className={MENU_ITEM}
        >
          <AgentIcon kind={agent} size={13} />
          {agentProvider(agent).label}
          <span className="ml-auto text-[10px] text-muted-4">{i + 1}</span>
        </button>
      ))}
      {!tabs.hasShell && (
        <>
          {addable.length > 0 && <div className="my-1 border-t border-line" />}
          <button
            type="button"
            aria-label="Open a terminal"
            title="A login shell on the project's main checkout"
            onClick={openTerminal}
            className={MENU_ITEM}
          >
            <TerminalIcon size={13} />
            Terminal
            <span className="ml-auto text-[10px] text-muted-4">{addable.length + 1}</span>
          </button>
        </>
      )}
    </>
  );
}
