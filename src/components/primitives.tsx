/** Small presentational primitives reused across views. */
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { accentActiveStyle, alpha } from "../theme/colors";
import { ChevronDownIcon } from "./icons";

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
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
  chevron?: boolean;
}) {
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

/** An iOS-style switch. */
export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className="relative h-[21px] w-[38px] flex-none cursor-pointer rounded-full border-none transition-colors duration-150"
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
 * A segmented button group (used for agent pickers). Generic over the option
 * value so callers stay type-safe.
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
  return (
    <div
      className={`flex gap-1 rounded-lg border border-line-2 bg-input p-[3px] ${className ?? ""}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const style: CSSProperties = active
          ? accentActiveStyle()
          : { border: "1px solid transparent", color: "var(--color-muted-2)" };
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-0.5 py-[7px] font-mono text-[11px] transition-all"
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
  /** Arbitrary trailing slot (a count, a pill, a {@link Badge}). */
  badge?: ReactNode;
  /** Render the inactive label in a fainter muted tone (e.g. disabled-ish). */
  dimmed?: boolean;
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
  return (
    <div
      className={`flex items-center gap-1 ${inset ? "" : "border-b border-line"} ${className ?? ""}`}
    >
      {tabs.map((t) => {
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
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            className={`${base} ${tabClassName ?? ""}`}
            style={style}
          >
            {t.icon}
            {t.label}
            {t.badge}
          </button>
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
}: {
  color: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex flex-none items-center rounded ${className ?? ""}`}
      style={{ color, background: alpha(12, color), border: `1px solid ${alpha(34, color)}` }}
    >
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

/**
 * A click-away dropdown: `trigger` renders the opener (it's handed a `toggle`),
 * `children` renders the menu (handed a `close`). The single source for the menus
 * the bottom bar and the start-task button each hand-rolled.
 *
 * Closes on outside click via a capture-phase `pointerdown` listener (not a
 * z-index backdrop) so it works even when the dropdown opens over the terminal
 * overlay — which shares the backdrop's stacking level and used to swallow the
 * close click. Escape closes it too.
 */
export function Dropdown({
  trigger,
  children,
  placement = "down",
  align = "left",
  menuClassName = "w-44 overflow-hidden",
}: {
  trigger: (toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  /** Open above (`up`) or below (`down`, default) the trigger. */
  placement?: "up" | "down";
  /** Anchor the menu to the trigger's left (default) or right edge. */
  align?: "left" | "right";
  /** Menu width / overflow classes (default `w-44 overflow-hidden`). */
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture phase so we still see the click even if an overlay (xterm) stops
    // propagation on its own pointerdown handler.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div
          className={`absolute z-40 rounded-lg border border-line-3 bg-raised py-1 shadow-lg ${
            placement === "up" ? "bottom-full mb-1" : "mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${menuClassName}`}
        >
          {children(() => setOpen(false))}
        </div>
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
  if (!open) return null;

  const accent = danger ? "var(--color-status-red)" : "var(--accent)";
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
            className="mt-2.5 rounded-md px-2.5 py-1.5 text-[11px] leading-[1.45]"
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
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="cursor-pointer rounded-md border border-line-2 bg-input px-3 py-1.5 text-[12px] text-muted-2 hover:text-fg-2 disabled:cursor-default disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:cursor-default"
            style={{ color: onAccent, background: accent, opacity: busy ? 0.85 : 1 }}
          >
            {busy && <Spinner size={11} color={onAccent} />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The thin (1.5px) drag strip on a resizable panel's edge. Spreads the pointer
 * handlers from {@link useEdgeResize}; `edge` places it just outside the matching
 * border (`left` for a right-hand panel, `right` for the left sidebar). Extracted
 * so the three panel resizers share one definition (and the lone `color-mix`
 * arbitrary-value, which can't be expressed via `alpha()` from a className).
 */
export function EdgeResizeHandle({
  edge,
  ...handlers
}: Pick<ComponentProps<"div">, "onPointerDown" | "onPointerMove" | "onPointerUp"> & {
  edge: "left" | "right";
}) {
  return (
    <div
      {...handlers}
      aria-hidden
      className={`absolute top-0 z-20 h-full w-1.5 cursor-col-resize hover:bg-[color-mix(in_srgb,var(--accent)_45%,transparent)] ${
        edge === "left" ? "left-[-3px]" : "right-[-3px]"
      }`}
    />
  );
}
