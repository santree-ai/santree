import { useEffect, useState } from "react";

/** prefers-reduced-motion as state that is ALWAYS false on the server and
 * on the first client render — so SSR markup can bake animated poses
 * without hydration mismatch, then collapse to rest post-hydration.
 * (framer's useReducedMotion reads the media query during render, which
 * would differ from the prerendered HTML.) */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
