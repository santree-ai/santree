/** The main-area tab bar. "Terminal" is always present and can't be closed;
 *  "Issue" (the ticket, like Triage) is present for per-issue worktrees but not
 *  the base-branch entry (it has no ticket). A shared "File" tab (whatever file
 *  you click) and a temporary "Setup" tab (while the setup script runs) appear on
 *  demand, and extra terminals opened via the trailing "+" tab are closable. All
 *  tabs share the same shape — a label with an optional trailing affordance (a
 *  close × or a status dot) in a fixed slot. */
import { type ReactNode, useEffect, useRef, useState } from "react";

import { CloseIcon, GlobeIcon, PlusIcon, TerminalIcon } from "../../components/icons";
import { Dropdown, MENU_ITEM, underlineTabStyle } from "../../components/primitives";
import { inEditable } from "../../lib/useKeyboardShortcuts";
import { CHROME } from "../../state/AppContext";
import { useTerminals } from "../terminal/TerminalsContext";
import { BASE_ID, type MainTab, termTab, useTrees } from "./model";

export function MainTabBar() {
  const {
    selectedFile,
    setupFor,
    activeId,
    activeTab,
    setActiveTab,
    closeFileTab,
    extraTerminals,
    addTerminal,
    closeTerminal,
  } = useTrees();
  const { tabs, close } = useTerminals();
  const isBase = activeId === BASE_ID;
  const hasFile = selectedFile !== null;
  const hasSetup = setupFor !== null && setupFor === activeId;

  // Closing an extra terminal tears down its PTY session (found by refId) too, so
  // it doesn't linger in the global Terminal tab.
  const closeExtra = (n: number) => {
    const refId = `tree:${activeId}:t${n}`;
    const tab = tabs.find((t) => t.refId === refId);
    if (tab) close(tab.key);
    closeTerminal(n);
  };

  // Auto-close an extra terminal tab once its process exits (its session vanishes
  // from `tabs`), so it disappears instead of lingering as a dead/gray tab you have
  // to ✕ by hand. We only prune a terminal we've *seen* live, so the brief gap
  // before a freshly-opened session registers doesn't drop it. This pane is keyed
  // by worktree id, so `seen` is naturally scoped to the active worktree.
  const seen = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const n of extraTerminals) {
      const alive = tabs.some((t) => t.refId === `tree:${activeId}:t${n}`);
      if (alive) seen.current.add(n);
      else if (seen.current.has(n)) {
        seen.current.delete(n);
        closeTerminal(n);
      }
    }
  }, [tabs, extraTerminals, activeId, closeTerminal]);

  return (
    <div className={`flex ${CHROME.subBar} flex-none items-stretch border-b border-line bg-deep`}>
      {!isBase && <Tab tab="issue" label="Issue" active={activeTab} onSelect={setActiveTab} />}
      <Tab tab="terminal" label="Terminal" active={activeTab} onSelect={setActiveTab} />
      {extraTerminals.map((n) => (
        <Tab
          key={n}
          tab={termTab(n)}
          label={`Terminal ${n}`}
          active={activeTab}
          onSelect={setActiveTab}
          onClose={() => closeExtra(n)}
        />
      ))}
      {hasFile && (
        <Tab
          tab="file"
          label="File"
          active={activeTab}
          onSelect={setActiveTab}
          onClose={closeFileTab}
        />
      )}
      {hasSetup && (
        <Tab
          tab="setup"
          label="Setup"
          active={activeTab}
          onSelect={setActiveTab}
          trailing={<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-amber" />}
        />
      )}
      <NewTabButton onAddTerminal={addTerminal} />
    </div>
  );
}

/** The trailing "+" tab: opens a new terminal (or a browser, once that's built).
 *  ⌘T opens the menu while a worktree is active (this bar is on screen); then
 *  1 selects Terminal and 2 would select Web (WIP — no-op for now). */
function NewTabButton({ onAddTerminal }: { onAddTerminal: () => void }) {
  const [open, setOpen] = useState(false);

  // ⌘T opens the menu. Scoped to this component's lifetime, which matches "a
  // worktree is active in Trees" (the bar only renders then).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key !== "t") return;
      if (inEditable(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Dropdown
      align="left"
      menuClassName="w-40 overflow-hidden"
      open={open}
      onOpenChange={setOpen}
      trigger={(toggle) => (
        // h-full so the button fills the bar's height (the Dropdown wrapper is a
        // block, so without it the button is content-height and rides up to the top
        // — visibly higher than the tabs). An SVG plus centers crisply.
        <button
          type="button"
          onClick={toggle}
          title="New tab (⌘T)"
          className="flex h-full w-8 cursor-pointer items-center justify-center text-muted-3 hover:bg-hover hover:text-fg-2"
        >
          <PlusIcon size={13} />
        </button>
      )}
    >
      {(close) => <NewTabMenu onAddTerminal={onAddTerminal} close={close} />}
    </Dropdown>
  );
}

/** New-tab menu rows. Mounted only while the menu is open, so its digit-key
 *  listener (1 → Terminal, 2 → Web) is live exactly when the menu is visible. */
function NewTabMenu({ onAddTerminal, close }: { onAddTerminal: () => void; close: () => void }) {
  const addTerminal = () => {
    onAddTerminal();
    close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inEditable(e.target)) return;
      if (e.key === "1") {
        e.preventDefault();
        onAddTerminal();
        close();
      } else if (e.key === "2") {
        // Web is WIP — swallow the key so it doesn't leak, but do nothing yet.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAddTerminal, close]);

  return (
    <>
      <button type="button" onClick={addTerminal} className={MENU_ITEM}>
        <TerminalIcon />
        Terminal
        <span className="ml-auto text-[10px] text-muted-4">1</span>
      </button>
      <button type="button" disabled title="Coming soon" className={MENU_ITEM}>
        <GlobeIcon />
        Web
        <span className="ml-auto text-[10px] text-muted-4">WIP</span>
      </button>
    </>
  );
}

function Tab({
  tab,
  label,
  active,
  onSelect,
  onClose,
  trailing,
}: {
  tab: MainTab;
  label: string;
  active: MainTab;
  onSelect: (tab: MainTab) => void;
  /** When set, the trailing slot is a close button. */
  onClose?: () => void;
  /** A non-interactive trailing affordance (e.g. a status dot). */
  trailing?: ReactNode;
}) {
  const on = active === tab;
  return (
    <div
      className="flex items-stretch border-r border-line text-[11.5px] font-medium"
      style={underlineTabStyle(on)}
    >
      <button type="button" onClick={() => onSelect(tab)} className="cursor-pointer pr-1.5 pl-3">
        {label}
      </button>
      {/* Fixed trailing slot so all tabs are the same shape. */}
      <span className="flex w-5 items-center justify-center pr-1.5">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-[13px] leading-none text-muted-3 hover:bg-hover hover:text-fg-2"
          >
            <CloseIcon size={10} />
          </button>
        ) : (
          trailing
        )}
      </span>
    </div>
  );
}
