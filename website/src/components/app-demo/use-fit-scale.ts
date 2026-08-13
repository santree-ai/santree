import { type RefObject, useEffect, useLayoutEffect } from "react";

/** The window is authored at a fixed desktop size and scaled to fit — real
 * 11px chrome downscaled reads like a screenshot, where responsive
 * reflowing would not. */
export const DESIGN_W = 1280;
export const DESIGN_H = 800;

// useLayoutEffect warns during SSR; both are no-ops there, so alias.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Exact scale-to-fit, hydration-safe: the measured scale is written as a
 * CSS var straight onto the node — never through React state — so server
 * and client markup stay byte-identical. Before this runs, styles.css
 * provides stepped fallbacks plus an exact container-query calc for
 * modern browsers (see .demo-fit). */
export function useFitScale(ref: RefObject<HTMLElement | null>) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.setProperty("--demo-scale", String(el.clientWidth / DESIGN_W));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
