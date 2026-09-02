import { m } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { SCREEN_H, SCREEN_W, SCREENS, type ScreenId, screenSrc } from "./screens";

/** The hero's showcase: a row of view pills over one window that crossfades
 * between real screenshots. It walks the views on its own every few seconds
 * until the visitor touches a pill, and pauses while scrolled out of view or
 * in a background tab. Every image is in the DOM (stacked, one visible), so
 * the prerendered page carries all five and a switch never waits on a fetch. */

const ADVANCE_MS = 6500;

export function ScreensShowcase() {
  const [active, setActive] = useState<ScreenId>("trees");
  const [cycling, setCycling] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const visible = useRef(true);

  useEffect(() => {
    if (!cycling) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = wrapRef.current;
    const io = el
      ? new IntersectionObserver(([entry]) => {
          visible.current = entry?.isIntersecting ?? true;
        })
      : null;
    if (el) io?.observe(el);
    const timer = window.setInterval(() => {
      if (!visible.current || document.hidden) return;
      setActive((current) => {
        const i = SCREENS.findIndex((s) => s.id === current);
        return SCREENS[(i + 1) % SCREENS.length]?.id ?? "trees";
      });
    }, ADVANCE_MS);
    return () => {
      window.clearInterval(timer);
      io?.disconnect();
    };
  }, [cycling]);

  const pick = (id: ScreenId) => {
    setCycling(false);
    setActive(id);
  };
  const current = SCREENS.find((s) => s.id === active) ?? SCREENS[0];

  return (
    <div ref={wrapRef} className="flex flex-col items-center gap-6">
      {/* fieldset's UA-magic layout (min-inline-size: min-content, special
          legend handling) breaks the horizontal scroll strip on phones —
          div+group is the reliable equivalent here. */}
      {/* biome-ignore lint/a11y/useSemanticElements: see the note above */}
      <div
        role="group"
        aria-label="Choose a santree view to preview"
        className="scrollbar-none -mx-6 flex max-w-full gap-1.5 overflow-x-auto px-6 sm:mx-0 sm:justify-center sm:px-0"
      >
        {SCREENS.map((s) => {
          const on = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => pick(s.id)}
              onMouseEnter={() => pick(s.id)}
              className={`relative shrink-0 overflow-hidden rounded-full border px-3.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors duration-200 ${
                on
                  ? "border-accent/35 bg-accent/10 text-accent"
                  : "border-hairline bg-white/2 text-muted hover:border-line-2 hover:text-fg"
              }`}
            >
              {s.label}
              {on && cycling && (
                <span
                  key={s.id}
                  className="screens-advance absolute inset-x-0 bottom-0 h-px bg-accent/70"
                />
              )}
            </button>
          );
        })}
      </div>
      <div
        className="relative w-full overflow-hidden rounded-xl border border-hairline bg-panel shadow-[0_1px_1px_rgba(0,0,0,0.45),0_24px_60px_-16px_rgba(0,0,0,0.65),0_48px_120px_-24px_rgba(0,0,0,0.8),0_0_120px_-40px_rgba(45,212,167,0.3)]"
        style={{ aspectRatio: `${SCREEN_W} / ${SCREEN_H}` }}
      >
        {SCREENS.map((s, i) => {
          const on = s.id === active;
          return (
            <m.img
              key={s.id}
              src={screenSrc(s.id)}
              alt={on ? s.alt : ""}
              width={SCREEN_W}
              height={SCREEN_H}
              loading={i === 0 ? "eager" : "lazy"}
              decoding="async"
              draggable={false}
              className="absolute inset-0 block h-full w-full select-none"
              initial={false}
              animate={{ opacity: on ? 1 : 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              style={{ pointerEvents: on ? "auto" : "none" }}
            />
          );
        })}
        <div
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{
            boxShadow:
              "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
          }}
          aria-hidden
        />
      </div>
      <p className="max-w-xl text-center text-[13px] leading-relaxed text-muted" aria-live="polite">
        {current?.caption}
      </p>
    </div>
  );
}
