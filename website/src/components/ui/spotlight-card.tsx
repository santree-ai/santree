import type { PointerEvent, ReactNode } from "react";

/** Card with a pointer-tracking radial highlight. The pointer position is
 * written straight to CSS vars (--mx/--my, read by the .spotlight rule in
 * styles.css) — no React re-render per move. */
export function SpotlightCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div className={`spotlight ${className}`} onPointerMove={onMove}>
      {children}
    </div>
  );
}
