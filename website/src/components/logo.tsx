/** The santree tree mark — the two triangles from app-icon.svg with the
 * emerald gradient, transparent background, viewBox recentered on the glyph. */
export function Logo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="112 112 288 288" className={className} aria-hidden>
      <defs>
        <linearGradient
          id="st-mark-g"
          x1="140"
          y1="120"
          x2="372"
          y2="392"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#c8f6e7" />
          <stop offset="0.24" stopColor="#4fd4ad" />
          <stop offset="0.47" stopColor="#e2fff5" />
          <stop offset="0.6" stopColor="#1f9c7d" />
          <stop offset="0.8" stopColor="#5fceac" />
          <stop offset="1" stopColor="#0c6f59" />
        </linearGradient>
      </defs>
      <g fill="url(#st-mark-g)">
        <path d="M256 128 L173 232 L339 232 Z" />
        <path d="M256 248 L148 384 L364 384 Z" />
      </g>
    </svg>
  );
}
