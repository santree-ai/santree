/** The main-area tab bar: the places you *work*, and — at its trailing edge —
 *  the two controls that act on the pane as a whole.
 *
 *  "Terminal" is always present and can't be closed. A shared "File" tab
 *  (whatever file you click) and a temporary "Setup" tab (while the setup script
 *  runs) appear on demand, and the persisted extra tabs opened via the "+" tab
 *  (agent sessions / terminals) are closable and renameable (double-click the
 *  label). All tabs share the same shape — an optional leading icon + label with
 *  an optional trailing affordance (a close × or a status dot) in a fixed slot.
 *
 *  The trailing cluster is not part of the tablist: the worktree's setup script
 *  (the one command this pane runs) and the right panel's expand control, which
 *  lives here only while the panel is hidden — collapsing it from its own header
 *  and reopening it somewhere else is how a toggle goes missing. It is a
 *  `flex-none` sibling of a `flex-1 min-w-0` tab area, so the tabs shrink around
 *  it and can never push it off the bar.
 *
 *  Narrow panes: a tab shrinks (its label ellipsises on one line) to `TAB_MIN_W`
 *  and no further — past that the strip drops tabs into an overflow menu instead
 *  of squeezing them into unreadable slivers. See {@link fitTabs}. */
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { AgentKind, TabKind, WorktreeTab } from "../../bindings";
import {
  AgentIcon,
  ChevronDownIcon,
  CloseIcon,
  GitHubLogo,
  GlobeIcon,
  PlayIcon,
  PlusIcon,
  TerminalIcon,
} from "../../components/icons";
import {
  Dropdown,
  MENU_ITEM,
  onTabStripKeyDown,
  underlineTabStyle,
} from "../../components/primitives";
import { useAgentAuth, useCodexAccount, useCodexHealth } from "../../lib/queries";
import { targetOwnsKey, useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { CHROME } from "../../state/AppContext";
import { agentLabel } from "../../theme/colors";
import { useTerminals } from "../terminal/TerminalsContext";
import { PanelToggle } from "./FilePickerPanel";
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
    openCheckLog,
    closeCheckLog,
    extraTabs,
    addTab,
    closeTab,
    renameTab,
    runSetup,
    rightCollapsed,
  } = useTrees();
  const { tabs, close } = useTerminals();
  const tabAreaRef = useRef<HTMLDivElement>(null);
  const tabAreaWidth = useTrackedWidth(tabAreaRef);
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

  // One list, so the fit/hide decision below sees every tab — the main work
  // terminal, the persisted extras, and the on-demand File/Setup/Check ones.
  const items: TabItem[] = [
    {
      // The main work terminal hosts the worktree's agent session, so it is
      // named after that agent — not after the pane. "Terminal" beside the Codex
      // mark, on a tab running Codex, is the tab lying about itself; an extra tab
      // has said `agentLabel(kind)` since it was born (see `defaultTabTitle`),
      // and this one had no `worktree_tabs` row to carry a title, which is the
      // only reason it ever said otherwise. The base entry is a plain shell and a
      // worktree with no agent yet has nothing to name, so both keep the literal.
      tab: "terminal",
      label: !isBase && active?.agent ? agentLabel(active.agent) : "Terminal",
      icon: !isBase && active?.agent ? <AgentTabIcon kind={active.agent} /> : undefined,
    },
    ...extraTabs.map((t) => ({
      tab: extraTab(t.id),
      label: t.title,
      icon:
        t.kind === "terminal" ? (
          <TerminalIcon size={11} className="text-muted-3" />
        ) : (
          <AgentTabIcon kind={t.agentKind ?? "Claude"} />
        ),
      onClose: () => closeExtra(t),
      onRename: (title: string) => renameTab(t.id, title),
    })),
    ...(hasFile ? [{ tab: "file" as const, label: "File", onClose: closeFileTab }] : []),
    ...(hasSetup
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
  const { shown, hidden } = fitTabs(
    items,
    items.findIndex((i) => i.tab === activeTab),
    tabAreaWidth,
  );

  return (
    // The bar doubles as the window's drag region for this column: with the
    // shell collapsed into one window, the sidebar's title strip was the only
    // draggable chrome, so grabbing the window anywhere over the work area was
    // impossible. `data-tauri-drag-region` only applies to the element under
    // the pointer, so the tabs and buttons inside keep their own clicks — the
    // gaps between them move the window, exactly like a native tab bar.
    <div
      data-tauri-drag-region
      className={`flex ${CHROME.subBar} flex-none items-stretch border-b border-line bg-deep`}
    >
      {/* Everything the tabs may use: `flex-1 min-w-0` so it takes what the
        trailing cluster leaves, and never a pixel more. Its measured width is
        the budget `fitTabs` spends, and it doesn't depend on how many tabs we
        render — so observing it can't feed back into itself. */}
      <div ref={tabAreaRef} className="flex min-w-0 flex-1 items-stretch">
        {/* The tablist clips rather than pushing: `min-w-0` + `overflow-hidden`
          means even a pathological pane width costs the last tab's right edge,
          not the "+" button or the controls beyond it. */}
        <div
          role="tablist"
          onKeyDown={onTabStripKeyDown}
          className="flex min-w-0 items-stretch overflow-hidden"
        >
          {shown.map((it) => (
            <Tab key={it.tab} {...it} active={activeTab} onSelect={setActiveTab} />
          ))}
        </div>
        {hidden.length > 0 && <OverflowTabsMenu tabs={hidden} onSelect={setActiveTab} />}
        <NewTabButton onAdd={addTab} />
        <div data-tauri-drag-region className="min-w-2 flex-1" />
      </div>

      <div data-tauri-drag-region className="flex flex-none items-center gap-0.5 pr-2 pl-2">
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
        {rightCollapsed && <PanelToggle />}
      </div>
    </div>
  );
}

/** Everything a {@link Tab} needs, so the whole strip can be built as one list
 *  and *then* fitted to the pane. */
type TabItem = {
  tab: MainTab;
  label: string;
  icon?: ReactNode;
  onClose?: () => void;
  onRename?: (title: string) => void;
  trailing?: ReactNode;
};

/** The narrow-pane budget, in px.
 *
 *  `TAB_MIN_W` is the floor a tab shrinks to — roughly the icon, the trailing
 *  slot and a few characters of label. Below it a tab is a sliver that names
 *  nothing, so the strip stops shrinking and starts hiding instead.
 *  `TAB_MAX_W` keeps one long renamed title from eating the whole strip.
 *  The other two mirror the trailing controls' own widths (`w-8` for "+", and
 *  the chevron + count for the overflow trigger), because they are spent out of
 *  the same budget as the tabs. */
const TAB_MIN_W = 84;
const TAB_MAX_W = 200;
const NEW_TAB_W = 32;
const OVERFLOW_W = 34;

/** Split the strip into the tabs that fit and the ones the overflow menu takes.
 *
 *  **The active tab is never hidden.** You cannot switch away from a tab you can
 *  no longer see, and dropping it would also leave the tablist with no
 *  `tabIndex={0}` element — the keyboard's only way into the strip. So it takes
 *  the last visible slot when it would otherwise have been dropped; everything
 *  else is dropped from the right, in order. (The alternative — hide by position
 *  and rely on the menu alone — makes the current tab's own name vanish, which
 *  is the one label that has to stay on screen.)
 *
 *  A width of 0 means "not measured yet" (first paint, or a test/headless
 *  environment with no layout): show everything rather than flash a collapsed
 *  strip that a measurement one frame later would undo. */
function fitTabs<T>(items: T[], activeIndex: number, width: number) {
  if (width <= 0) return { shown: items, hidden: [] as T[] };
  if (Math.floor((width - NEW_TAB_W) / TAB_MIN_W) >= items.length)
    return { shown: items, hidden: [] as T[] };
  // Hiding costs the overflow trigger, so the budget shrinks the moment we do it.
  const keep = Math.max(1, Math.floor((width - NEW_TAB_W - OVERFLOW_W) / TAB_MIN_W));
  const visible = new Set<number>();
  for (let i = 0; i < keep && i < items.length; i++) visible.add(i);
  if (activeIndex >= 0 && !visible.has(activeIndex)) {
    visible.delete(keep - 1);
    visible.add(activeIndex);
  }
  return {
    shown: items.filter((_, i) => visible.has(i)),
    hidden: items.filter((_, i) => !visible.has(i)),
  };
}

/** An element's live width. `ResizeObserver` is guarded because jsdom has none;
 *  there the first (0-width) read stands, which {@link fitTabs} reads as
 *  "unmeasured, show everything". */
function useTrackedWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(el.getBoundingClientRect().width);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** The tabs that didn't fit, reachable from a menu. Menu rows are buttons, not
 *  `role="tab"`s — a hidden tab is out of the DOM entirely, so it can't strand
 *  the roving tabindex, and picking one here makes it visible again (it becomes
 *  the active tab, which {@link fitTabs} always keeps). */
function OverflowTabsMenu({
  tabs,
  onSelect,
}: {
  tabs: TabItem[];
  onSelect: (tab: MainTab) => void;
}) {
  const label = `Show ${tabs.length} hidden ${tabs.length === 1 ? "tab" : "tabs"}`;
  return (
    <Dropdown
      align="right"
      menuClassName="w-52 overflow-hidden"
      trigger={(toggle) => (
        // h-full so the trigger fills the bar like the tabs beside it (the
        // Dropdown wrapper is a block, so a content-height button rides up).
        <button
          type="button"
          onClick={toggle}
          title={label}
          aria-label={label}
          className="flex h-full cursor-pointer items-center gap-0.5 border-r border-line px-1.5 text-[11px] font-medium text-muted-2 hover:bg-hover hover:text-fg-2"
        >
          {tabs.length}
          <ChevronDownIcon size={11} />
        </button>
      )}
    >
      {(close) =>
        tabs.map((t) => (
          <button
            key={t.tab}
            type="button"
            onClick={() => {
              onSelect(t.tab);
              close();
            }}
            className={MENU_ITEM}
          >
            {t.icon ?? <span className="w-[11px]" />}
            <span className="truncate">{t.label}</span>
          </button>
        ))
      }
    </Dropdown>
  );
}

/** The agent's logomark for the main work tab — Claude gets its brand color so
 *  the spark reads as "Claude" at a glance; other agents use the text color. */
function AgentTabIcon({ kind }: { kind: AgentKind }) {
  return <AgentIcon kind={kind} size={11} className="text-muted-3" />;
}

/** The trailing "+" tab: opens a new Claude session or terminal (or a browser,
 *  once that's built). ⌘T opens the menu while a worktree is active (this bar is
 *  on screen); then 1 selects Claude, 2 Terminal, and 3 would select Web (WIP). */
function NewTabButton({ onAdd }: { onAdd: (kind: TabKind, agentKind?: AgentKind) => void }) {
  const [open, setOpen] = useState(false);

  // ⌘T opens the menu. Scoped to this component's lifetime, which matches "a
  // worktree is active in Trees" (the bar only renders then).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key !== "t") return;
      if (targetOwnsKey(e)) return;
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
      // The floor and the cap the strip is fitted to (see `fitTabs`): a tab
      // shrinks between them and its label ellipsises, never below the floor —
      // `MainTabBar` only renders as many tabs as fit at that floor.
      style={{ ...underlineTabStyle(on), minWidth: TAB_MIN_W, maxWidth: TAB_MAX_W }}
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
          // The title also carries the full label, which a narrow pane may have
          // ellipsised away.
          title={onRename ? `${label} — double-click (or F2) to rename` : label}
          // `min-w-0` is what lets the button shrink past its content: without
          // it a flex child's automatic minimum size is its min-content width,
          // which for a two-word label is one word — so the label wrapped onto a
          // second line instead of ellipsising.
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1.5 pl-3"
        >
          {icon && <span className="flex flex-none items-center">{icon}</span>}
          <span className="truncate">{label}</span>
        </button>
      )}
      {/* Fixed trailing slot so all tabs are the same shape — `flex-none` so the
        shrinking label can never eat the close button. */}
      <span className="flex w-5 flex-none items-center justify-center pr-1.5">
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
