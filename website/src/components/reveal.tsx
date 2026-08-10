import { type ReactNode, useEffect, useRef } from "react";

/** Progressive-enhancement reveal. The server HTML is fully visible — no
 * opacity-0 baked into the static page, so crawlers and no-JS visitors see
 * everything. After hydration, elements still BELOW the viewport get hidden
 * and rise in (CSS transition, .reveal-pre/.reveal-in in styles.css) when
 * scrolled to. Reduced motion: never hidden at all. */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already on screen (or above it) — leave it alone.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;

    el.classList.add("reveal-pre");
    if (delay) el.style.transitionDelay = `${delay}s`;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.add("reveal-in");
          io.disconnect();
        }
      },
      { rootMargin: "-8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
