/** The main-area tab strip: the places you *work*, and — at its trailing edge —
 *  whatever controls act on the pane as a whole.
 *
 *  Two hosts sit on it and mean the same thing by it (the way both right panels
 *  share {@link SidePanel}): the worktree's tabs in Trees
 *  ({@link features/trees/MainTabBar}) and the pull request's in Reviews
 *  ({@link features/reviews/ReviewTabBar}). Every tab has the same shape — an
 *  optional leading icon + a label with an optional trailing affordance (a close ×
 *  or a status dot) in a fixed slot — closes when its host gives it an `onClose`,
 *  and renames in place (double-click, or F2) when it gives it an `onRename`.
 *
 *  It owns no state and knows nothing about either host's model: which tabs
 *  exist, what closing one does and what the "+" menu offers all come in as
 *  props. What lives here is the chrome, the fitting and the keyboard model, so
 *  the two strips can't drift into two window managers that feel different for no
 *  reason.
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

import { targetOwnsKey } from "../lib/useKeyboardShortcuts";
import { CHROME } from "../state/AppContext";
import { ChevronDownIcon, CloseIcon, PlusIcon } from "./icons";
import { Dropdown, MENU_ITEM, onTabStripKeyDown, underlineTabStyle } from "./primitives";

/** Everything a tab needs, so the whole strip can be built as one list and *then*
 *  fitted to the pane. */
export interface StripTab<T extends string> {
  tab: T;
  label: string;
  /** Leading logomark (e.g. the Claude spark on agent tabs). */
  icon?: ReactNode;
  /** When set, the trailing slot is a close button. */
  onClose?: () => void;
  /** When set, double-clicking (or F2 on) the label edits it inline. */
  onRename?: (title: string) => void;
  /** A non-interactive trailing affordance (e.g. a status dot). Ignored when the
   *  tab closes — one slot, and the close × wins it. */
  trailing?: ReactNode;
  /** A count or mark that belongs to what the tab *contains* (an AI review's
   *  draft count, say) rather than to what you can do to the tab.
   *
   *  Distinct from {@link trailing} because they lose to different things: the
   *  affordance slot is one slot and the close × takes it, so a count put there
   *  disappears the moment a tab becomes closable. This rides inside the tab,
   *  after the label, and survives. */
  badge?: ReactNode;
}

export function TabStrip<T extends string>({
  tabs,
  active,
  onSelect,
  newTabMenu,
  newTabMenuClassName,
  trailing,
  ariaLabel,
}: {
  tabs: StripTab<T>[];
  active: T | null;
  onSelect: (tab: T) => void;
  /** The tablist's accessible name — a view can have a second strip inside a tab
   *  (Reviews does), and "tab list" twice over names neither. */
  ariaLabel: string;
  /** The "+" menu's rows; `close` dismisses it. Omitted on a strip that opens
   *  nothing, which drops the button with it. */
  newTabMenu?: (close: () => void) => ReactNode;
  /** The menu's own width class — the rows are the host's, so their measure is
   *  too. */
  newTabMenuClassName?: string;
  /** The host's own cluster at the far edge — outside the tablist, because these
   *  act on the pane rather than being places in it. */
  trailing?: ReactNode;
}) {
  const tabAreaRef = useRef<HTMLDivElement>(null);
  const tabAreaWidth = useTrackedWidth(tabAreaRef);
  const { shown, hidden } = fitTabs(
    tabs,
    tabs.findIndex((t) => t.tab === active),
    tabAreaWidth,
    !!newTabMenu,
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
          not the "+" button or the controls beyond it. It goes entirely once
          every tab is closed — a tablist owning no tabs is not a thing. */}
        {shown.length > 0 && (
          <div
            role="tablist"
            aria-label={ariaLabel}
            onKeyDown={onTabStripKeyDown}
            className="flex min-w-0 items-stretch overflow-hidden"
          >
            {shown.map((it) => (
              <Tab key={it.tab} {...it} active={active} onSelect={onSelect} />
            ))}
          </div>
        )}
        {hidden.length > 0 && <OverflowTabsMenu tabs={hidden} onSelect={onSelect} />}
        {newTabMenu && <NewTabButton menu={newTabMenu} menuClassName={newTabMenuClassName} />}
        <div data-tauri-drag-region className="min-w-2 flex-1" />
      </div>

      <div data-tauri-drag-region className="flex flex-none items-center gap-0.5 pr-2 pl-2">
        {trailing}
      </div>
    </div>
  );
}

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
function fitTabs<T>(items: T[], activeIndex: number, width: number, hasNewTab = true) {
  if (width <= 0) return { shown: items, hidden: [] as T[] };
  const newTab = hasNewTab ? NEW_TAB_W : 0;
  if (Math.floor((width - newTab) / TAB_MIN_W) >= items.length)
    return { shown: items, hidden: [] as T[] };
  // Hiding costs the overflow trigger, so the budget shrinks the moment we do it.
  const keep = Math.max(1, Math.floor((width - newTab - OVERFLOW_W) / TAB_MIN_W));
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
function OverflowTabsMenu<T extends string>({
  tabs,
  onSelect,
}: {
  tabs: StripTab<T>[];
  onSelect: (tab: T) => void;
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

/** The trailing "+" tab. ⌘T opens the menu while the strip is on screen; the rows
 *  (and any digit shortcuts on them) belong to the host. */
function NewTabButton({
  menu,
  menuClassName = "w-52 overflow-hidden",
}: {
  menu: (close: () => void) => ReactNode;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  // ⌘T opens the menu. Scoped to this component's lifetime, which matches "a
  // workspace is on screen" (the bar only renders then).
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
      menuClassName={menuClassName}
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
      {(close) => menu(close)}
    </Dropdown>
  );
}

function Tab<T extends string>({
  tab,
  label,
  icon,
  active,
  onSelect,
  onClose,
  onRename,
  trailing,
  badge,
}: StripTab<T> & {
  active: T | null;
  onSelect: (tab: T) => void;
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
      // the strip only renders as many tabs as fit at that floor.
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
          {badge && <span className="flex flex-none items-center">{badge}</span>}
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
