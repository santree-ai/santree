/**
 * The one shape every status-bar segment wears.
 *
 * The bar is 24px tall and everything in it is read at a glance, so the resting
 * color, hit area and spacing are fixed once here instead of per segment — a row
 * of segments that each style themselves drifts a pixel at a time until the bar
 * looks uneven. Muted at rest and brighter on hover, because color in this bar is
 * reserved for state worth acting on (an urgent count, a meter past its warn
 * threshold) and spending it on chrome would make those unreadable.
 */
import type { ComponentPropsWithoutRef } from "react";

/** Layout for a segment's contents (glyph + label), shared by every segment. */
export const STATUS_SEGMENT = "flex h-full items-center gap-1.5 whitespace-nowrap";

/**
 * A clickable status-bar segment.
 *
 * Everything else passes straight through to the button — including the
 * `aria-haspopup`/`aria-expanded` pair {@link Dropdown} clones onto its trigger,
 * which a hand-rolled prop list would silently drop.
 */
export function StatusButton({
  active = false,
  className,
  ...rest
}: ComponentPropsWithoutRef<"button"> & {
  /** The segment reflects an "on" state (an engaged toggle), so it stays lit. */
  active?: boolean;
}) {
  return (
    <button
      type="button"
      // No local focus ring: the app's one ring lives in `styles.css` and is
      // gated on input modality, and a `ring-*` box-shadow here would sit
      // outside that gate — leaving an accent box on the bar after a click.
      className={`${STATUS_SEGMENT} cursor-pointer rounded-sm px-1 transition-colors ${
        active ? "text-fg-2" : "text-muted-4 hover:text-fg-2"
      } ${className ?? ""}`}
      {...rest}
    />
  );
}
