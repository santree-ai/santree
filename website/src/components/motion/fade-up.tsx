import { m } from "framer-motion";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

/** Progressive-enhancement reveal on framer-motion (port of reveal.tsx).
 * The server HTML carries no animation styles — `initial={false}` and an
 * undefined `animate` mean crawlers and no-JS visitors see everything.
 * After hydration, elements still BELOW the viewport are hidden in a
 * duration-0 step and rise in when scrolled to. Reduced motion: never
 * hidden at all (checked here because MotionConfig's reducedMotion="user"
 * would still run opacity fades — our convention is stronger). */

type Phase = "idle" | "hidden" | "show";

const HIDDEN = { opacity: 0, y: 12 };
const SHOW = { opacity: 1, y: 0 };
const EASE = [0.22, 0.61, 0.36, 1] as const;

function useArmedReveal(ref: RefObject<HTMLDivElement | null>): Phase {
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Already on screen (or above it) — leave it alone.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;

    setPhase("hidden");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setPhase("show");
          io.disconnect();
        }
      },
      { rootMargin: "-8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return phase;
}

export function FadeUp({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const phase = useArmedReveal(ref);

  return (
    <m.div
      ref={ref}
      className={className}
      initial={false}
      animate={phase === "idle" ? undefined : phase}
      variants={{
        hidden: { ...HIDDEN, transition: { duration: 0 } },
        show: { ...SHOW, transition: { duration: 0.55, ease: EASE, delay } },
      }}
    >
      {children}
    </m.div>
  );
}

/** Parent/child pair for staggered card grids. Items inherit the group's
 * variant, so only the group runs the viewport logic. */
export function FadeUpGroup({
  children,
  stagger = 0.06,
  className,
}: {
  children: ReactNode;
  stagger?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const phase = useArmedReveal(ref);

  return (
    <m.div
      ref={ref}
      className={className}
      initial={false}
      animate={phase === "idle" ? undefined : phase}
      variants={{
        hidden: { transition: { duration: 0 } },
        show: { transition: { staggerChildren: stagger } },
      }}
    >
      {children}
    </m.div>
  );
}

export function FadeUpItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <m.div
      className={className}
      initial={false}
      variants={{
        hidden: { ...HIDDEN, transition: { duration: 0 } },
        show: { ...SHOW, transition: { duration: 0.55, ease: EASE } },
      }}
    >
      {children}
    </m.div>
  );
}
