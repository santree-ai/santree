import { SCREEN_H, SCREEN_W, type ScreenId, screenSrc } from "./screens";

/** One screenshot in a window frame: the real capture (no OS shadow; the
 * frame supplies its own), a hairline edge lit from the top, and a soft
 * emerald bloom underneath. `priority` marks the hero's first image, which
 * must not lazy-load. */
export function AppFrame({
  id,
  alt,
  priority = false,
  className = "",
}: {
  id: ScreenId;
  alt: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_1px_1px_rgba(0,0,0,0.45),0_24px_60px_-16px_rgba(0,0,0,0.65),0_48px_120px_-24px_rgba(0,0,0,0.8),0_0_120px_-40px_rgba(45,212,167,0.3)] ${className}`}
    >
      <img
        src={screenSrc(id)}
        alt={alt}
        width={SCREEN_W}
        height={SCREEN_H}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        className="block h-auto w-full select-none"
        draggable={false}
      />
      {/* Edge lighting: a brighter hairline along the top. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
        aria-hidden
      />
    </div>
  );
}
