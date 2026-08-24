/** Small presentational primitives reused across views. */
import {
  type ComponentProps,
  type CSSProperties,
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { formatElapsed, useElapsed } from "../lib/useElapsed";
import { accentActiveStyle, alpha } from "../theme/colors";
import { ChevronDownIcon } from "./icons";

/** The visual tiers a labeled action button can have. One filled style per
 *  intent — never hand-roll a new one:
 *  - `primary` — THE filled call-to-action (accent fill + on-accent text).
 *  - `danger`  — the filled destructive action (red + on-danger).
 *  - `tinted`  — accent-tinted secondary emphasis (e.g. header Investigate).
 *  - `outline` — the neutral chip (header/bar actions, dialog Cancel).
 *  - `ghost`   — borderless de-emphasized action (Clear, Dismiss).
 */
export type ButtonVariant = "primary" | "danger" | "tinted" | "outline" | "ghost";

export type ButtonSize = "sm" | "md" | "lg";

/** One radius, one type scale — chips are `sm`, standalone actions `md`,
 *  full-width panel CTAs `lg`. */
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "gap-1.5 rounded-md px-2.5 py-1 text-[11px]",
  md: "gap-1.5 rounded-md px-3 py-1.5 text-[12px]",
  lg: "gap-2 rounded-md px-3.5 py-2 text-[12.5px]",
};

/** Class + style per variant. Every variant carries a border (transparent when
 *  invisible) so all variants of a size are the exact same height, and border
 *  colors never rely on utility-order tiebreaks. */
const BUTTON_VARIANT: Record<ButtonVariant, { cls: string; style?: CSSProperties }> = {
  primary: {
    cls: "border-transparent bg-accent-fill font-semibold hover:opacity-90",
    style: { color: "var(--on-accent)" },
  },
  danger: {
    cls: "border-transparent font-semibold hover:opacity-90",
    style: { background: "var(--color-status-red)", color: "var(--on-danger)" },
  },
  tinted: {
    cls: "font-medium",
    style: { background: alpha(11), borderColor: alpha(30), color: "var(--accent-text)" },
  },
  outline: {
    cls: "border-line-2 bg-input font-medium text-muted-2 hover:border-line-strong hover:text-fg-2",
  },
  ghost: {
    cls: "border-transparent font-medium text-muted-2 hover:bg-hover hover:text-fg-2",
  },
};

/**
 * The app's ONE labeled action button. Anything a user clicks that reads as a
 * button (CTAs, header chips, dialog actions) renders through this — list rows,
 * cards, menu items, tabs, and icon-only ghosts are their own families.
 * `className` appends layout (widths/margins); `style` merges last so callers
 * can layer state styling (e.g. `accentActiveStyle()` on a toggled chip).
 */
export function Button({
  variant = "outline",
  size = "md",
  className,
  style,
  type = "button",
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
} & ComponentProps<"button">) {
  const v = BUTTON_VARIANT[variant];
  return (
    <button
      type={type}
      className={`flex cursor-pointer items-center justify-center border transition-colors disabled:cursor-default disabled:opacity-50 ${BUTTON_SIZE[size]} ${v.cls} ${className ?? ""}`}
      style={{ ...v.style, ...style }}
      {...rest}
    />
  );
}

/**
 * A native `<select>` with the browser arrow removed and our own chevron
 * overlaid — the pattern the launch tray and settings dropdowns each hand-rolled.
 * `className` styles the select (callers keep their own tokens); `wrapperClassName`
 * is for layout on the positioning wrapper (e.g. margins).
 */
export function ChevronSelect({
  value,
  onChange,
  className,
  wrapperClassName,
  children,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  wrapperClassName?: string;
  children: ReactNode;
} & Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "value" | "onChange" | "className" | "children"
>) {
  return (
    <div className={`relative ${wrapperClassName ?? ""}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`cursor-pointer appearance-none ${className ?? ""}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={12}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-3"
      />
    </div>
  );
}

/**
 * A free-text field with a suggestion list (native `<input list>` + `<datalist>`).
 * Use where the canonical options are known but not exhaustive — e.g. model names:
 * the suggestions cover the common aliases, but the CLI is the source of truth, so
 * you can type any alias/id it accepts (`opus`, `claude-fable-5`, …) and never be
 * stuck behind a stale hardcoded list. Empty is a valid value (callers treat it as
 * "default"). `chevron` overlays the same arrow as {@link ChevronSelect} for visual
 * parity in dropdown rows.
 */
export function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  className,
  wrapperClassName,
  chevron = true,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
  chevron?: boolean;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | "type"
  | "list"
  | "value"
  | "onChange"
  | "placeholder"
  | "spellCheck"
  | "autoComplete"
  | "className"
>) {
  const listId = useId();
  return (
    <div className={`relative ${wrapperClassName ?? ""}`}>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={className ?? ""}
        {...rest}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
      {chevron && (
        <ChevronDownIcon
          size={12}
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-3"
        />
      )}
    </div>
  );
}

/** A pulsing placeholder bar for loading states. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span className={`block animate-pulse rounded bg-skeleton ${className ?? ""}`} style={style} />
  );
}

/**
 * Placeholder rows for a list whose data hasn't arrived yet.
 *
 * The distinction this exists to preserve: a query with no data yet means "we
 * don't know", which is not the same as "there is nothing". Rendering an empty
 * state from `data ?? []` asserts the second while only the first is true — the
 * file picker claimed "No changes." on every worktree until its status landed.
 * Gate on `data === undefined` and render this instead.
 *
 * Widths vary per row so the block reads as content rather than a progress bar;
 * they're derived from the index (not random) so re-renders don't reshuffle it.
 */
export function ListSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 px-3 py-2 ${className ?? ""}`} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          // Static placeholders in a fixed-length list — there is no identity to
          // key by, and the list never reorders.
          key={i}
          className="h-3"
          style={{ width: `${[82, 64, 74, 56, 88, 68, 78, 60][i % 8]}%` }}
        />
      ))}
    </div>
  );
}

/**
 * "This is still running" — a spinner, a label, and a ticking m:ss clock, for the
 * AI calls that legitimately take minutes (the review brief, the tutor analysis).
 *
 * The clock is the point. A bare spinner looks identical whether the model is
 * reading a 200 KB diff or the process died three minutes ago, so the user's only
 * move is to guess and press the button again. Past `slowAfterMs` the label swaps
 * to `slowLabel`, which sets the expectation *while* the wait is happening rather
 * than after it.
 */
export function RunningStatus({
  active,
  label,
  slowLabel,
  slowAfterMs = 45_000,
  className = "",
}: {
  active: boolean;
  label: string;
  /** Shown once the run passes `slowAfterMs`. Defaults to `label`. */
  slowLabel?: string;
  slowAfterMs?: number;
  className?: string;
}) {
  const elapsed = useElapsed(active);
  if (!active) return null;
  const slow = elapsed >= slowAfterMs;
  return (
    <div
      // Announce politely: the label changes mid-run, and a live region is how a
      // screen reader learns the wait is still progressing rather than stuck.
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 text-[11.5px] text-muted-3 ${className}`}
    >
      <Spinner size={12} />
      <span className="min-w-0 flex-1">{slow ? (slowLabel ?? label) : label}</span>
      <span className="flex-none font-mono text-[10.5px] text-muted-4 tabular-nums">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}

/** A spinning ring, themable by color. */
export function Spinner({ size = 11, color = "var(--accent)" }: { size?: number; color?: string }) {
  return (
    <span
      className="inline-block animate-spin rounded-full"
      style={{
        width: size,
        height: size,
        // `alpha()` (color-mix) instead of a `${color}33` hex-suffix so the faint
        // ring renders for CSS-var colors like `var(--accent)` too.
        border: `1.6px solid ${alpha(20, color)}`,
        borderTopColor: color,
      }}
    />
  );
}

/** Six-pixel terminal activity chase for pane-level work. Unlike the compact ring
 *  spinner used inside buttons, this reads as part of the IDE's own language. */
export function TerminalActivity({
  label = "Working…",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-2 font-mono text-[10.5px] text-muted-3 ${className}`}
    >
      <span className="terminal-activity" aria-hidden>
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} style={{ animationDelay: `${index * 110}ms` }} />
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}

/** A small status dot, optionally glowing. */
export function Dot({
  color,
  size = 7,
  glow = false,
}: {
  color: string;
  size?: number;
  glow?: boolean;
}) {
  return (
    <span
      className="flex-none rounded-full"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: glow ? `0 0 7px ${color}` : undefined,
      }}
    />
  );
}

/**
 * A project's glyph: its emoji icon when it has one, else a colored dot. Linear
 * projects can use an emoji or a named icon from a set we don't ship, so named
 * icons (plain ASCII identifiers) fall back to the dot.
 */
export function ProjectGlyph({
  color,
  icon,
  size = 7,
}: {
  color: string;
  icon?: string | null;
  size?: number;
}) {
  // An emoji's first codepoint is non-ASCII; a Linear icon name ("Rocket") isn't.
  if (icon && (icon.codePointAt(0) ?? 0) > 0x7f) {
    return (
      <span aria-hidden className="leading-none" style={{ fontSize: size + 4 }}>
        {icon}
      </span>
    );
  }
  return <Dot color={color} size={size} />;
}

/**
 * A centered empty/placeholder state — an optional icon over a title and an
 * optional fainter subtitle. The single source for the "nothing here" panels
 * each view used to hand-roll (issue with no body, empty triage queue, …).
 */
export function EmptyState({
  icon,
  title,
  subtitle,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center ${className ?? ""}`}
    >
      {icon}
      <div className="text-[12.5px] text-muted-2">{title}</div>
      {subtitle && <div className="text-[11px] leading-[1.5] text-muted-4">{subtitle}</div>}
    </div>
  );
}

/**
 * An iOS-style switch. `ariaLabel`/`ariaLabelledBy` give the switch an
 * accessible name — most callers pass `ariaLabelledBy` pointing at a sibling
 * label element they already render (e.g. {@link ToggleRow}); a standalone
 * toggle with no visible label should pass `ariaLabel` instead. `disabled`
 * sets the real `disabled` attribute (so it's unreachable/announced as
 * disabled by assistive tech, not just click-swallowed) and dims the control.
 */
export function Toggle({
  on,
  onClick,
  disabled,
  ariaLabel,
  ariaLabelledBy,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className="relative h-[21px] w-[38px] flex-none cursor-pointer rounded-full border-none transition-colors duration-150 disabled:cursor-default disabled:opacity-45"
      style={{ background: on ? "var(--accent)" : "var(--color-line-3)" }}
    >
      <span
        className="absolute top-[2px] h-[17px] w-[17px] rounded-full bg-white transition-[left] duration-150"
        style={{ left: on ? 18 : 2, boxShadow: "0 1px 2px rgba(0,0,0,.4)" }}
      />
    </button>
  );
}

/**
 * The index Arrow/Home/End should move to inside a horizontal composite widget
 * (a tablist, a radiogroup, one of the tab strips), or `null` for a key it
 * doesn't handle. Wraps at both ends.
 */
function rovingTarget(key: string, current: number, count: number): number | null {
  const from = current < 0 ? 0 : current;
  if (key === "ArrowRight" || key === "ArrowDown") return (from + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (from - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Arrow/Home/End focus roving over the `role="tab"` children of a `role="tablist"`
 * — spread on the strip element itself. Pair it with a roving tabindex on the
 * tabs (`tabIndex={active ? 0 : -1}`) so the strip is a single Tab stop.
 *
 * Manual activation (focus moves, selection doesn't follow): our tab panels are
 * heavyweight — a route, a PTY-backed terminal — so arrowing past a tab must not
 * activate it. Enter/Space on the focused tab still selects, via its own click.
 */
export function onTabStripKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  // Only rove when a tab itself has focus: a strip also holds close buttons and
  // (in Trees) an inline rename field, whose own arrow-key handling must win.
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  const next = rovingTarget(e.key, current, tabs.length);
  if (next === null) return;
  e.preventDefault();
  tabs[next]?.focus();
}

/**
 * A segmented button group (used for agent pickers). Generic over the option
 * value so callers stay type-safe.
 *
 * A real radiogroup: one Tab stop (the checked option), and the arrow keys move
 * *and* check — which is what a radiogroup's role promises, and what the
 * checked-follows-focus convention expects.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const checked = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const next = rovingTarget(e.key, checked, options.length);
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={`flex gap-1 rounded-lg border border-line-2 bg-input p-[2px] ${className ?? ""}`}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        const style: CSSProperties = active
          ? accentActiveStyle()
          : { border: "1px solid transparent", color: "var(--color-muted-2)" };
        return (
          // biome-ignore lint/a11y/useSemanticElements: custom-styled segmented control, not a native radio input.
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: with nothing checked yet, the first option is the
            // one Tab lands on, so the group can never fall out of the tab order.
            tabIndex={(checked < 0 ? 0 : checked) === i ? 0 : -1}
            onClick={() => onChange(opt.value)}
            // `whitespace-nowrap`: the control is often placed in a fixed-height
            // bar, where a wrapped label silently grows it past the row height.
            // `leading-none`: the inherited 1.5 line-height adds ~5px of invisible
            // box around an 11px label, which — doubled by this control's box-in-a-box
            // nesting — is most of why the pill used to tower over its own text.
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-0.5 py-[3px] font-mono text-[11px] leading-none whitespace-nowrap transition-all"
            style={style}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** A single tab definition for {@link Tabs}. */
export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Native tooltip, useful for discoverable keyboard shortcuts in chrome. */
  title?: string;
  /** Arbitrary trailing slot (a count, a pill, a {@link Badge}). */
  badge?: ReactNode;
  /** Render the inactive label in a fainter muted tone (e.g. disabled-ish). */
  dimmed?: boolean;
  /** Draw a vertical rule after this tab, setting it apart from the rest of the
   *  strip (the nav's Agents section, which spans every other view). */
  separatorAfter?: boolean;
}

/**
 * Underline style for {@link Tabs}:
 *  - `border` (default): a 2px bottom-border underline sitting on a `border-b`
 *    rail — the original look, used by content/detail tab bars.
 *  - `inset`: an `inset 0 -2px 0` box-shadow underline with no rail — used by
 *    the top {@link NavTabs} chrome where the tabs fill the header height.
 */
export type TabsVariant = "border" | "inset";

/**
 * A horizontal tab bar with an accent underline on the active tab. Generic over
 * the tab value so callers stay type-safe.
 *
 * Props:
 *  - `tabs` — the tab items (label + optional icon / `badge` slot / `dimmed`).
 *  - `value` / `onChange` — controlled active tab.
 *  - `variant` — `border` (default) or `inset` underline (see {@link TabsVariant}).
 *  - `accent` — underline color; defaults to the live `--accent` token.
 *  - `tabClassName` — extra classes applied to every tab button (so chrome
 *    callers can stretch tabs to the header height with e.g. `items-center`).
 *
 * Inactive tabs use the shared muted token (`--color-muted-2`, or
 * `--color-muted-4` when `dimmed`) — never a hardcoded gray — so they flip
 * correctly in light mode.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  tabClassName,
  variant = "border",
  accent = "var(--accent)",
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  tabClassName?: string;
  variant?: TabsVariant;
  accent?: string;
}) {
  const inset = variant === "inset";
  const selected = tabs.findIndex((t) => t.value === value);
  return (
    <div
      role="tablist"
      onKeyDown={onTabStripKeyDown}
      className={`flex items-center gap-1 ${inset ? "" : "border-b border-line"} ${className ?? ""}`}
    >
      {tabs.map((t, i) => {
        const active = t.value === value;
        const inactiveColor = t.dimmed ? "var(--color-muted-4)" : "var(--color-muted-2)";
        const style: CSSProperties = inset
          ? active
            ? {
                color: "var(--color-fg-bright)",
                fontWeight: 500,
                boxShadow: `inset 0 -2px 0 ${accent}`,
              }
            : { color: inactiveColor }
          : active
            ? { color: "var(--color-fg-bright)", borderColor: accent }
            : { color: inactiveColor, borderColor: "transparent" };
        const base = inset
          ? "flex cursor-pointer items-center gap-1.5 px-3 text-[13px] transition-colors hover:text-fg-2"
          : "-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors hover:text-fg-2";
        const tab = (
          <button
            key={t.value}
            type="button"
            title={t.title}
            role="tab"
            aria-selected={active}
            // Roving tabindex — the strip is one Tab stop; the arrow keys move
            // between tabs (see {@link onTabStripKeyDown}). Falls back to the
            // first tab so an unmatched `value` can't strand the whole strip
            // outside the tab order.
            tabIndex={(selected < 0 ? 0 : selected) === i ? 0 : -1}
            onClick={() => onChange(t.value)}
            className={`${base} ${tabClassName ?? ""}`}
            style={style}
          >
            {t.icon}
            {t.label}
            {t.badge}
          </button>
        );
        if (!t.separatorAfter) return tab;
        return (
          <div key={t.value} className="flex h-full items-center gap-1">
            {tab}
            <span aria-hidden className="h-[15px] w-px flex-none bg-line" />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A tinted chip: text in `color` over a faint `color` wash with a `color` border.
 * The single source for the soft color-coded pills (priority, status, badges)
 * that several views hand-rolled with the `${hex}15`/`${hex}40` suffix trick —
 * which silently broke for CSS-var colors. Uses `alpha()` so `var(--accent)`
 * works too. `className` controls size/padding/typography.
 */
export function Pill({
  color,
  children,
  className,
  title,
  onClick,
}: {
  color: string;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Renders as a clickable `<button>` instead of a plain `<span>` when set —
   *  e.g. {@link PrChip}'s pressable PR pill. Visual output is otherwise identical. */
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const style: CSSProperties = {
    color,
    background: alpha(12, color),
    border: `1px solid ${alpha(34, color)}`,
  };
  const classes = `inline-flex flex-none items-center rounded ${className ?? ""}`;
  if (onClick) {
    return (
      <button
        type="button"
        title={title}
        onClick={onClick}
        className={`cursor-pointer ${classes}`}
        style={style}
      >
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={classes} style={style}>
      {children}
    </span>
  );
}

/** A subtle pill badge (e.g. RDY, connected). A {@link Pill} at a fixed small size. */
export function Badge({
  children,
  color,
  className,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <Pill
      color={color ?? "var(--accent)"}
      className={`px-[5px] py-px font-mono text-[9px] font-semibold tracking-wide ${className ?? ""}`}
    >
      {children}
    </Pill>
  );
}

/** Selector for a menu's interactive rows — used to move focus into the menu on
 *  open and to rove between items with the arrow keys. Matches `role="menuitem"`
 *  where a caller sets it, and falls back to any enabled `<button>` since most
 *  existing menus (built from the shared {@link MENU_ITEM} class) don't. */
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), button:not([disabled])';

/** Focusable-element selector — the elements a keyboard user could actually land
 *  on. Used by {@link useModalA11y}'s Tab trap and by {@link Dropdown} to find
 *  its trigger when handing focus back. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A click-away dropdown: `trigger` renders the opener (it's handed a `toggle`),
 * `children` renders the menu (handed a `close`). The single source for the menus
 * the bottom bar and the start-task button each hand-rolled.
 *
 * The menu is rendered through a portal to `document.body` at a z-index above
 * the terminal overlay (a `fixed` z-30 layer that forms its own stacking
 * context). An in-flow `absolute` menu would paint *behind* that overlay
 * whenever it opened over the terminal (bottom bar, tab bar); the portal
 * escapes the local stacking context so the menu always sits on top.
 *
 * Closes on outside click via a capture-phase `pointerdown` listener (not a
 * z-index backdrop) so it works even when the dropdown opens over the terminal
 * overlay — which used to swallow the close click. Escape closes it too.
 *
 * Menu-button semantics are wired centrally so callers don't each have to do it:
 * `trigger`'s returned element is cloned with `aria-haspopup`/`aria-expanded`
 * (it's always a single interactive element in practice — a plain clone is a
 * no-op if it isn't), focus moves to the first menu item on open, and
 * Up/Down/Home/End rove focus between items (the ad-hoc digit shortcuts a
 * couple of menus already have keep working independently of this).
 */
export function Dropdown({
  trigger,
  children,
  placement = "down",
  align = "left",
  menuClassName = "w-44 overflow-hidden",
  open: openProp,
  onOpenChange,
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  /** Open above (`up`) or below (`down`, default) the trigger. */
  placement?: "up" | "down";
  /** Anchor the menu to the trigger's left (default) or right edge. */
  align?: "left" | "right";
  /** Menu width / overflow classes (default `w-44 overflow-hidden`). */
  menuClassName?: string;
  /** Controlled open state. When set (with `onOpenChange`) the parent owns
   *  open/close — e.g. to trigger the menu from a keyboard shortcut. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (value: boolean) => {
    if (onOpenChange) onOpenChange(value);
    else setOpenState(value);
  };
  // Stable closer for the outside-click / Escape listeners so the effect below
  // doesn't re-register on every render.
  const close = useCallback(() => {
    if (onOpenChange) onOpenChange(false);
    else setOpenState(false);
  }, [onOpenChange]);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Fixed-position coordinates for the portaled menu, anchored to the trigger.
  const [coords, setCoords] = useState<CSSProperties | null>(null);

  // Measure the trigger and derive the menu's fixed position. Re-runs while open
  // on scroll/resize so the menu tracks the trigger (it lives in document.body,
  // not next to the trigger, so it can't rely on normal layout to follow it).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const next: CSSProperties = {
        position: "fixed",
        ...(placement === "up"
          ? { bottom: window.innerHeight - r.top + 4 }
          : { top: r.bottom + 4 }),
        ...(align === "right" ? { right: window.innerWidth - r.right } : { left: r.left }),
      };
      setCoords(next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, placement, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The menu is portaled out of `ref`, so check it separately — otherwise a
      // click inside the menu reads as "outside" and closes it before the item
      // handler runs.
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Capture phase so we still see the click even if an overlay (xterm) stops
    // propagation on its own pointerdown handler.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Move focus into the menu when it opens — covers both click-opened and
  // controlled/shortcut-opened dropdowns (both flow through `open`) — and hand it
  // back to the trigger on close, so Escape / picking an item / clicking away
  // doesn't drop focus onto <body>. The restore is skipped when the close already
  // moved focus somewhere real (e.g. a click straight into another control), so
  // we never yank it back out from under the user.
  //
  // Keyed on the portal being *mounted*, not on `open`: the menu only renders
  // once the layout effect above has measured `coords`, a commit later — on
  // `open` alone this ran while `menuRef` was still null and focus never moved.
  // A boolean (not `coords` itself) so re-measuring on scroll/resize doesn't
  // snap focus back to the first item mid-rove.
  const menuMounted = open && coords !== null;
  useEffect(() => {
    if (!menuMounted) return;
    menuRef.current?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
    return () => {
      const active = document.activeElement;
      const stranded = !active || active === document.body || !!menuRef.current?.contains(active);
      if (!stranded) return;
      ref.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    };
  }, [menuMounted]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (current === -1) next = e.key === "ArrowDown" ? 0 : items.length - 1;
    else if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else next = (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  // `trigger` is caller-controlled and in every current usage returns a single
  // <button> — clone it to add the menu-button aria pair without every call
  // site wiring it by hand. Falls back to rendering as-is for anything that
  // isn't a single element (e.g. a Fragment).
  const renderedTrigger = trigger(() => setOpen(!open));
  const triggerNode = isValidElement<Record<string, unknown>>(renderedTrigger)
    ? cloneElement(renderedTrigger, { "aria-haspopup": "menu", "aria-expanded": open })
    : renderedTrigger;

  return (
    <div ref={ref} className="relative">
      {triggerNode}
      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            style={coords}
            className={`z-[200] rounded-lg border border-line-3 bg-raised py-1 shadow-lg ${menuClassName}`}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Shared row class for items inside a `Dropdown` menu. */
export const MENU_ITEM =
  "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[12px] text-fg-3 hover:bg-hover disabled:cursor-default disabled:text-muted-4 disabled:hover:bg-transparent";

/** Active/inactive style for an "inset underline" tab (a `bg-app` fill with an
 *  `inset 0 -2px 0` accent rule) — shared by the main-area and file-picker tab
 *  bars so the look can't drift. */
export function underlineTabStyle(active: boolean): CSSProperties {
  return {
    color: active ? "var(--color-fg-2)" : "var(--color-muted-2)",
    background: active ? "var(--color-app)" : "transparent",
    boxShadow: active ? "inset 0 -2px 0 var(--accent)" : "none",
  };
}

/**
 * Focus management for a modal `role="dialog"`, shared by {@link ConfirmDialog}
 * and `CreatePrDialog` so the two don't drift:
 *  - on open, remembers whatever had focus and moves focus to `initialFocusRef`
 *    (typically the dialog's Cancel button);
 *  - Escape closes the dialog, unless `busy` (an in-flight action shouldn't be
 *    dismissable mid-flight);
 *  - Tab/Shift-Tab is trapped within `dialogRef`, wrapping at both ends, so
 *    focus can't leak to the page behind the modal;
 *  - on close, focus returns to whatever triggered the dialog.
 */
export function useModalA11y({
  open,
  busy = false,
  onClose,
  dialogRef,
  initialFocusRef,
}: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
}) {
  const restoreRef = useRef<HTMLElement | null>(null);

  // Move focus in on open, restore it on close. initialFocusRef is a ref
  // object (stable by contract) so it's deliberately left off the deps list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialFocusRef is a ref, stable by contract.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    initialFocusRef.current?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open]);

  // Escape-to-close + Tab trap.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !root.contains(active);
      if (e.shiftKey) {
        if (outside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (outside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose, dialogRef]);
}

/**
 * A modal confirmation for a destructive action. Unlike `window.confirm`, it
 * runs the action inline and shows its *status*: a spinner while the work runs,
 * the error message if it fails (the dialog stays open to retry), and it only
 * closes once the action resolves. `onConfirm` should return a promise.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  busyLabel = "Working…",
  danger = false,
  extra,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  danger?: boolean;
  /** Optional content between the message and the buttons (e.g. a "don't ask
   *  again" checkbox). */
  extra?: ReactNode;
  /** Runs the action; its resolved value is ignored — the dialog only cares
   *  whether it resolves (close) or rejects (show the error, stay open). */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalA11y({ open, busy, onClose, dialogRef, initialFocusRef: cancelRef });
  // Reset stale busy/error state left over from a previous open — the component
  // stays mounted across `open` flips (see the early-return below), so without
  // this a failed confirm from days ago would flash its old error on reopen.
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);
  if (!open) return null;

  const onAccent = danger ? "var(--on-danger)" : "var(--on-accent)";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => !busy && onClose()}
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label={title}
        className="relative w-[380px] max-w-full rounded-xl border border-line-3 bg-panel p-4 shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="text-[13px] font-semibold text-fg-bright">{title}</div>
        <div className="mt-1.5 text-[12px] leading-[1.5] text-fg-2">{message}</div>
        {error && (
          <div
            className="selectable mt-2.5 rounded-md px-2.5 py-1.5 text-[11px] leading-[1.45]"
            style={{
              color: "var(--color-status-red)",
              background: alpha(10, "var(--color-status-red)"),
              border: `1px solid ${alpha(30, "var(--color-status-red)")}`,
            }}
          >
            {error}
          </div>
        )}
        {extra && <div className="mt-3">{extra}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={run}
            disabled={busy}
            style={{ opacity: busy ? 0.85 : 1 }}
          >
            {busy && <Spinner size={11} color={onAccent} />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The thin (1.5px) drag strip on a resizable panel's edge. Spreads the pointer
 * handlers (and now keyboard handler + aria-value* trio) from {@link useEdgeResize};
 * `edge` places it just outside the matching border (`left` for a right-hand
 * panel, `right` for the left sidebar). Extracted so the three panel resizers
 * share one definition (and the lone `color-mix` arbitrary-value, which can't
 * be expressed via `alpha()` from a className).
 *
 * A focusable, keyboard-operable `role="separator"` rather than `aria-hidden`
 * — ⌘B/⌘L collapse the panel outright, but this is the only way to *resize*
 * it without a pointer; see {@link useEdgeResize}'s `onKeyDown` for the
 * ArrowLeft/ArrowRight handling. This is the WAI-ARIA "focusable separator"
 * pattern (used for resizable splitters), which is why it stays a `<div>`
 * with a role rather than a semantic element like `<hr>`.
 */
export function EdgeResizeHandle({
  edge,
  "aria-valuenow": valueNow,
  "aria-valuemin": valueMin,
  "aria-valuemax": valueMax,
  ...pointerHandlers
}: Pick<
  ComponentProps<"div">,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onKeyDown"
  | "aria-valuenow"
  | "aria-valuemin"
  | "aria-valuemax"
> & {
  edge: "left" | "right";
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: focusable/keyboard-resizable separator (WAI-ARIA splitter pattern), not a decorative <hr>.
    <div
      {...pointerHandlers}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-label="Resize panel"
      tabIndex={0}
      className={`absolute top-0 z-20 h-full w-1.5 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--accent)_45%,transparent)] ${
        edge === "left" ? "left-[-3px]" : "right-[-3px]"
      }`}
    />
  );
}
