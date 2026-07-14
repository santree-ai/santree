/** The main-area tab bar. "Terminal" is always present and can't be closed;
 *  "Issue" (the ticket, like Triage) is present for per-issue worktrees but not
 *  the base-branch entry (it has no ticket). A shared "File" tab (whatever file
 *  you click) and a temporary "Setup" tab (while the setup script runs) appear on
 *  demand, and the persisted extra tabs opened via the trailing "+" tab (Claude
 *  sessions / terminals) are closable and renameable (double-click the label).
 *  All tabs share the same shape — an optional leading icon + label with an
 *  optional trailing affordance (a close × or a status dot) in a fixed slot. */
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { AgentKind, TabKind, WorktreeTab } from "../../bindings";
import {
  AgentIcon,
  ClaudeSparkIcon,
  CloseIcon,
  GlobeIcon,
  PlusIcon,
  TerminalIcon,
} from "../../components/icons";
import {
  Dropdown,
  MENU_ITEM,
  onTabStripKeyDown,
  underlineTabStyle,
} from "../../components/primitives";
import { inEditable, useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { CHROME } from "../../state/AppContext";
import { useTerminals } from "../terminal/TerminalsContext";
import { BASE_ID, extraTab, type MainTab, useTrees } from "./model";

export function MainTabBar() {
  const {
    active,
    selectedFile,
    setupFor,
    activeId,
    activeTab,
    setActiveTab,
    closeFileTab,
    extraTabs,
    addTab,
    closeTab,
    renameTab,
  } = useTrees();
  const { tabs, close } = useTerminals();
  const isBase = activeId === BASE_ID;
  const hasFile = selectedFile !== null;
  const hasSetup = setupFor !== null && setupFor === activeId;

  // Closing an extra tab tears down its PTY session (found by refId) too, so it
  // doesn't linger in the global Terminal tab (and a Claude tab's stored session
  // is forgotten by the backend).
  const closeExtra = (t: WorktreeTab) => {
    const refId = `tree:${activeId}:tab:${t.id}`;
    const live = tabs.find((x) => x.refId === refId);
    if (live) close(live.key);
    closeTab(t.id);
  };

  // Auto-close an extra *terminal* tab once its shell exits (its session vanishes
  // from `tabs`), so it disappears instead of lingering as a dead/gray tab you
  // have to ✕ by hand. We only prune a tab we've *seen* live, so the brief gap
  // before a freshly-opened session registers doesn't drop it. Claude tabs are
  // exempt: their session is meant to outlive the process (quitting claude shows
  // the resume pane; the tab comes back after an app restart too). This pane is
  // keyed by worktree id, so `seen` is naturally scoped to the active worktree.
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of extraTabs) {
      if (t.kind !== "terminal") continue;
      const alive = tabs.some((x) => x.refId === `tree:${activeId}:tab:${t.id}`);
      if (alive) seen.current.add(t.id);
      else if (seen.current.has(t.id)) {
        seen.current.delete(t.id);
        closeTab(t.id);
      }
    }
  }, [tabs, extraTabs, activeId, closeTab]);

  return (
    <div
      role="tablist"
      onKeyDown={onTabStripKeyDown}
      className={`flex ${CHROME.subBar} flex-none items-stretch border-b border-line bg-deep`}
    >
      {!isBase && <Tab tab="issue" label="Issue" active={activeTab} onSelect={setActiveTab} />}
      {/* The main work terminal hosts the worktree's agent session — mark it with
          the agent's logo once one has been launched (the base entry is a plain
          shell, and a worktree with no agent yet has nothing to mark). */}
      <Tab
        tab="terminal"
        label="Terminal"
        icon={!isBase && active?.agent ? <AgentTabIcon kind={active.agent} /> : undefined}
        active={activeTab}
        onSelect={setActiveTab}
      />
      {extraTabs.map((t) => (
        <Tab
          key={t.id}
          tab={extraTab(t.id)}
          label={t.title}
          icon={
            // Claude + Fix-CI tabs both host a Claude session — mark them with the
            // spark; only plain terminal tabs get the shell glyph.
            t.kind === "terminal" ? (
              <TerminalIcon size={11} className="text-muted-3" />
            ) : (
              <ClaudeSparkIcon />
            )
          }
          active={activeTab}
          onSelect={setActiveTab}
          onClose={() => closeExtra(t)}
          onRename={(title) => renameTab(t.id, title)}
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
      <NewTabButton onAdd={addTab} />
    </div>
  );
}

/** The agent's logomark for the main work tab — Claude gets its brand color so
 *  the spark reads as "Claude" at a glance; other agents use the text color. */
function AgentTabIcon({ kind }: { kind: AgentKind }) {
  if (kind === "Claude") return <ClaudeSparkIcon />;
  return <AgentIcon kind={kind} size={11} className="text-muted-3" />;
}

/** The trailing "+" tab: opens a new Claude session or terminal (or a browser,
 *  once that's built). ⌘T opens the menu while a worktree is active (this bar is
 *  on screen); then 1 selects Claude, 2 Terminal, and 3 would select Web (WIP). */
function NewTabButton({ onAdd }: { onAdd: (kind: TabKind) => void }) {
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
      {(close) => <NewTabMenu onAdd={onAdd} close={close} />}
    </Dropdown>
  );
}

/** New-tab menu rows. Mounted only while the menu is open, so its digit-key
 *  listener (1 → Claude, 2 → Terminal, 3 → Web) is live exactly when the menu is
 *  visible. */
function NewTabMenu({ onAdd, close }: { onAdd: (kind: TabKind) => void; close: () => void }) {
  const add = (kind: TabKind) => {
    onAdd(kind);
    close();
  };

  // 1 → Claude, 2 → Terminal, 3 → Web (WIP: it owns the key but does nothing yet).
  useDigitShortcuts([() => add("claude"), () => add("terminal"), null]);

  return (
    <>
      <button type="button" onClick={() => add("claude")} className={MENU_ITEM}>
        <ClaudeSparkIcon size={13} />
        Claude
        <span className="ml-auto text-[10px] text-muted-4">1</span>
      </button>
      <button type="button" onClick={() => add("terminal")} className={MENU_ITEM}>
        <TerminalIcon />
        Terminal
        <span className="ml-auto text-[10px] text-muted-4">2</span>
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
  icon,
  active,
  onSelect,
  onClose,
  onRename,
  trailing,
}: {
  tab: MainTab;
  label: string;
  /** Leading logomark (e.g. the Claude spark on agent tabs). */
  icon?: ReactNode;
  active: MainTab;
  onSelect: (tab: MainTab) => void;
  /** When set, the trailing slot is a close button. */
  onClose?: () => void;
  /** When set, double-clicking the label edits it inline. */
  onRename?: (title: string) => void;
  /** A non-interactive trailing affordance (e.g. a status dot). */
  trailing?: ReactNode;
}) {
  const on = active === tab;
  const [editing, setEditing] = useState(false);
  return (
    // Presentational wrapper: the strip is the tablist and the label button is the
    // tab — the close × has to stay a sibling of it, because a tab's children are
    // presentational to AT and it would disappear inside one.
    <div
      role="presentation"
      className="flex items-stretch border-r border-line text-[11.5px] font-medium"
      style={underlineTabStyle(on)}
    >
      {editing && onRename ? (
        <RenameInput
          initial={label}
          onDone={(title) => {
            setEditing(false);
            if (title) onRename(title);
          }}
        />
      ) : (
        <button
          type="button"
          role="tab"
          aria-selected={on}
          tabIndex={on ? 0 : -1}
          onClick={() => onSelect(tab)}
          onDoubleClick={onRename ? () => setEditing(true) : undefined}
          // F2 is the keyboard path to the rename the double-click opens —
          // without it renaming a tab is pointer-only.
          onKeyDown={
            onRename
              ? (e) => {
                  if (e.key !== "F2") return;
                  e.preventDefault();
                  setEditing(true);
                }
              : undefined
          }
          title={onRename ? "Double-click (or F2) to rename" : undefined}
          className="flex cursor-pointer items-center gap-1.5 pr-1.5 pl-3"
        >
          {icon}
          {label}
        </button>
      )}
      {/* Fixed trailing slot so all tabs are the same shape. */}
      <span className="flex w-5 items-center justify-center pr-1.5">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label={`Close ${label}`}
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

/** The inline rename field a tab swaps to on double-click. Enter/blur commit,
 *  Escape cancels; committing is latched so Enter's commit isn't followed by the
 *  unmount blur re-firing `onDone`. */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (title: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field replaces the label the user just double-clicked — focus must follow.
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || null);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
      aria-label="Tab name"
      className="my-1 ml-2 rounded border border-line bg-app px-1.5 text-[11.5px] text-fg-2 outline-none focus-visible:border-accent"
      style={{ width: `${Math.min(Math.max(value.length + 3, 10), 32)}ch` }}
    />
  );
}
