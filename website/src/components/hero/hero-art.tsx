import { useEffect, useRef } from "react";

/** The baked hero artwork, given life: a slow scroll parallax (the light
 * recedes at ~0.12x scroll speed and dims as you leave the hero) and a
 * faint pointer drift (±14px, critically damped). Transform/opacity only,
 * one rAF loop, disabled under reduced motion — the static image is the
 * experience, this is just breath. */
export function HeroArt() {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let mx = 0;
    let my = 0;
    let cx = 0;
    let cy = 0;
    let cs = 0; // eased scroll offset

    const onPointer = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 28;
      my = (e.clientY / window.innerHeight - 0.5) * 14;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const target = Math.min(window.scrollY, 1200);
      cx += (mx - cx) * 0.06;
      cy += (my - cy) * 0.06;
      cs += (target - cs) * 0.12;
      el.style.transform = `translate3d(${cx.toFixed(2)}px, ${(cy - cs * 0.12).toFixed(2)}px, 0)`;
      el.style.opacity = String(Math.max(0.45, 1 - cs / 1400));
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <img
      ref={ref}
      src="/hero-art.jpg"
      alt=""
      width={2400}
      height={1600}
      fetchPriority="high"
      draggable={false}
      className="w-[1200px] max-w-none flex-none select-none will-change-transform sm:w-[1760px]"
    />
  );
}
