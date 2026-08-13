import { type RefObject, useEffect, useState } from "react";

/** True only while the demo should animate: on screen, tab visible, and no
 * reduced-motion preference. Starts false, so the server and first client
 * render agree on the frozen t=0 frame. */
export function usePlaying(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false), {
      threshold: 0.15,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return inView && !pageHidden && !reduced;
}
