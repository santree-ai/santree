/** Small presentational primitives reused across views. */
import type { CSSProperties, ReactNode, SelectHTMLAttributes } from "react";

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
        border: `1.6px solid ${color}33`,
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
          ? {
              background: "color-mix(in srgb, var(--accent) 13%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
              color: "var(--accent)",
            }
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

/** A subtle pill badge (e.g. RDY, connected). */
export function Badge({
  children,
  color,
  className,
}: {
  children: React.ReactNode;
  color?: string;
  className?: string;
}) {
  const c = color ?? "var(--accent)";
  return (
    <span
      className={`rounded font-mono text-[9px] font-semibold tracking-wide ${className ?? ""}`}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}
