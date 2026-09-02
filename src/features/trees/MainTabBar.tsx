/** Trees' main tab bar: the worktree's tabs on the shared {@link TabStrip}, plus
 *  the two controls that act on the pane as a whole.
 *
 *  Every tab is a `worktree_tabs` row — the agents and shells a worktree has
 *  open, including the one a started task runs in — and every one of them closes
 *  and renames (double-click the label). Close them all and the pane falls
 *  through to its empty surface, with this bar (and its "+") still on top. Beside
 *  them, on demand: the worktree's pull request and its ticket at reading width
 *  ("GitHub PR", "Linear" — the right panel's panes, expanded), a shared "File"
 *  tab (whatever file you click) and a temporary "Setup" tab (while the setup
 *  script runs).
 *
 *  The trailing cluster is not part of the tablist: the worktree's setup script
 *  (the one command this pane runs) and the right panel's expand control, which
 *  lives here only while the panel is hidden — collapsing it from its own header
 *  and reopening it somewhere else is how a toggle goes missing.
 *
 *  This file is only Trees' *wiring*: the chrome, the fitting and the keyboard
 *  model belong to the strip, which knows nothing about either host's model. */
import type { AgentKind, TabKind } from "../../bindings";
import {
  AgentIcon,
  GitHubLogo,
  GlobeIcon,
  LinearLogo,
  PlayIcon,
  TerminalIcon,
} from "../../components/icons";
import { MENU_ITEM } from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { type StripTab, TabStrip } from "../../components/TabStrip";
import { useAgentAuth, useCodexAccount, useCodexHealth } from "../../lib/queries";
import { useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { BASE_ID, extraTab, type MainTab, useTrees } from "./model";
import { useTabSessions } from "./useTabSessions";

export function MainTabBar() {
  const {
    active,
    selectedFile,
    setupFor,
    activeId,
    activeTab,
    setActiveTab,
    closeFileTab,
    openCheckLog,
    closeCheckLog,
    prViewOpen,
    closePrView,
    issueViewOpen,
    closeIssueView,
    tabs,
    addTab,
    closeTab,
    renameTab,
    runSetup,
    rightCollapsed,
    toggleRightPanel,
  } = useTrees();
  const { closeWithSession } = useTabSessions(activeId, tabs, closeTab);
  const isBase = activeId === BASE_ID;

  // One list, so the fit/hide decision sees every tab — the persisted rows and
  // the on-demand ones, in `openMainTabs`' order.
  const items: StripTab<MainTab>[] = [
    ...tabs.map((t) => ({
      tab: extraTab(t.id),
      label: t.title,
      icon:
        t.kind === "terminal" ? (
          <TerminalIcon size={11} className="text-muted-3" />
        ) : (
          // The agent's logomark. Claude's spark reads as "Claude" at a glance;
          // every mark takes the text colour so the strip stays one weight.
          <AgentIcon kind={t.agentKind ?? "Claude"} size={11} className="text-muted-3" />
        ),
      onClose: () => closeWithSession(t),
      onRename: (title: string) => renameTab(t.id, title),
    })),
    ...(prViewOpen
      ? [
          {
            tab: "prView" as const,
            label: "GitHub PR",
            icon: <GitHubLogo size={11} className="text-muted-3" />,
            onClose: closePrView,
          },
        ]
      : []),
    ...(issueViewOpen
      ? [
          {
            tab: "issueView" as const,
            label: "Linear",
            icon: <LinearLogo size={11} className="text-muted-3" />,
            onClose: closeIssueView,
          },
        ]
      : []),
    ...(selectedFile !== null
      ? [{ tab: "file" as const, label: "File", onClose: closeFileTab }]
      : []),
    ...(setupFor !== null && setupFor === activeId
      ? [
          {
            tab: "setup" as const,
            label: "Setup",
            trailing: <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-amber" />,
          },
        ]
      : []),
    ...(openCheckLog
      ? [
          {
            tab: "checkLog" as const,
            label: openCheckLog.name,
            icon: <GitHubLogo size={11} className="text-muted-3" />,
            onClose: closeCheckLog,
          },
        ]
      : []),
  ];

  return (
    <TabStrip
      tabs={items}
      active={activeTab}
      onSelect={setActiveTab}
      ariaLabel="Worktree tabs"
      newTabMenu={(close) => <NewTabMenu onAdd={addTab} close={close} />}
      newTabMenuClassName="w-40 overflow-hidden"
      trailing={
        <>
          {!isBase && active && (
            <button
              type="button"
              onClick={() => runSetup(active.id)}
              title="Run .santree/init.sh and watch its logs"
              className="flex h-[22px] cursor-pointer items-center gap-1.5 rounded px-2 text-[11px] whitespace-nowrap text-muted-2 hover:bg-hover hover:text-fg-2"
            >
              <PlayIcon size={10} />
              {active.setupRan ? "Re-run setup" : "Run setup"}
            </button>
          )}
          {rightCollapsed && <PanelToggle collapsed onToggle={toggleRightPanel} />}
        </>
      }
    />
  );
}

/** New-tab menu rows: a new Claude/Codex session or a terminal (or a browser,
 *  once that's built). Mounted only while the menu is open, so its digit-key
 *  listener (1 → Codex, 2 → Claude Code, 3 → Terminal) is live exactly when the
 *  menu is visible. */
function NewTabMenu({
  onAdd,
  close,
}: {
  onAdd: (kind: TabKind, agentKind?: AgentKind) => void;
  close: () => void;
}) {
  const claude = useAgentAuth("Claude").data;
  const codexHealth = useCodexHealth().data;
  const codexAccount = useCodexAccount(codexHealth?.available === true).data;
  const codexReady = !!codexHealth?.available && !!codexAccount?.connected;
  const claudeReady = !!claude?.connected;
  const add = (kind: TabKind, agentKind?: AgentKind) => {
    if (agentKind === "Codex" && !codexReady) return;
    if (agentKind === "Claude" && !claudeReady) return;
    if (agentKind) onAdd(kind, agentKind);
    else onAdd(kind);
    close();
  };

  // Provider choice is explicit: 1 → Codex, 2 → Claude Code, 3 → Terminal.
  useDigitShortcuts([
    () => add("agent", "Codex"),
    () => add("agent", "Claude"),
    () => add("terminal"),
  ]);

  return (
    <>
      <button
        type="button"
        disabled={!codexReady}
        title={codexReady ? undefined : "Connect Codex in Settings first"}
        onClick={() => add("agent", "Codex")}
        className={MENU_ITEM}
      >
        <AgentIcon kind="Codex" size={13} />
        Codex
        <span className="ml-auto text-[10px] text-muted-4">1</span>
      </button>
      <button
        type="button"
        disabled={!claudeReady}
        title={claudeReady ? undefined : "Sign in to Claude Code first"}
        onClick={() => add("agent", "Claude")}
        className={MENU_ITEM}
      >
        <AgentIcon kind="Claude" size={13} />
        Claude Code
        <span className="ml-auto text-[10px] text-muted-4">2</span>
      </button>
      <button type="button" onClick={() => add("terminal")} className={MENU_ITEM}>
        <TerminalIcon />
        Terminal
        <span className="ml-auto text-[10px] text-muted-4">3</span>
      </button>
      <button type="button" disabled title="Coming soon" className={MENU_ITEM}>
        <GlobeIcon />
        Web
        <span className="ml-auto text-[10px] text-muted-4">WIP</span>
      </button>
    </>
  );
}
