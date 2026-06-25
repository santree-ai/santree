/** Small presentational primitives reused across views. */
import type { CSSProperties } from "react";

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

/** An iOS-style switch. */
export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className="relative h-[21px] w-[38px] flex-none cursor-pointer rounded-full border-none transition-colors duration-150"
      style={{ background: on ? "var(--accent)" : "#2a2a31" }}
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
          : { border: "1px solid transparent", color: "#8b8b94" };
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
