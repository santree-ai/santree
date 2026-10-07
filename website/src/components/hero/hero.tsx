import { m, useScroll, useTransform } from "framer-motion";
import { DownloadButton } from "~/components/download-button";
import { HeroCanvas } from "~/components/hero/hero-canvas";
import { GitHubLogo } from "~/components/icons";
import { ScreensShowcase } from "~/components/screens";
import { usePrefersReducedMotion } from "~/lib/use-reduced-motion";

export function Hero() {
  // As the page scrolls past the showcase, the headline drifts up and the
  // background art dims — one light system handing off to the other.
  // Ranges collapse to rest under reduced motion (state starts false, so
  // server and first client render agree).
  const reduced = usePrefersReducedMotion();
  const { scrollY } = useScroll();
  const textY = useTransform(scrollY, [0, 500], reduced ? [0, 0] : [0, -40]);
  const artOpacity = useTransform(scrollY, [0, 420], reduced ? [1, 1] : [1, 0.3]);

  return (
    <section className="relative">
      {/* Background: CSS aurora (the SSR/no-JS base light) + the generative
          worktree-stream canvas + a static scrim seating the text. Overflow
          is clipped here, NOT on the section — the demo below scales past
          its box while docking. */}
      <m.div
        aria-hidden
        style={{ opacity: artOpacity }}
        className="absolute inset-0 overflow-hidden"
      >
        <div className="hero-aurora" />
        <HeroCanvas className="hero-canvas-mask absolute inset-0 size-full" />
        {/* Scrim: seats the text in a darker pocket. Static — it must not
            move with anything. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 58% 52% at 50% 42%, rgba(7,8,10,0.72), rgba(7,8,10,0.22) 62%, transparent 80%)",
          }}
        />
      </m.div>

      <m.div
        style={{ y: textY }}
        className="hero-text relative mx-auto max-w-3xl px-6 pt-44 text-center sm:pt-52"
      >
        <h1 className="rise text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[4.5rem]">
          Your backlog,
          <br />
          <span className="text-gradient-emerald">shipped in parallel.</span>
        </h1>
        <p className="rise rise-1 mx-auto mt-7 max-w-xl text-pretty text-[17px] leading-relaxed text-[#c9cad2]">
          santree runs Codex and Claude Code on your repo&rsquo;s tickets, each agent in its own git
          worktree, and one sidebar shows you which of them needs you. Triage in, PRs out.
        </p>
        <div className="rise rise-2 mt-10 flex flex-wrap items-center justify-center gap-3">
          <DownloadButton size="lg" />
          <a href="https://github.com/santree-ai/santree" className="btn btn-ghost h-11 px-5">
            <GitHubLogo size={15} />
            Read the source
          </a>
        </div>
        <p className="rise rise-3 mt-7 font-mono text-[11px] tracking-wide text-[#8f9099]">
          macOS · free · MIT licensed
        </p>
      </m.div>

      {/* The app, as it is: real captures of each view, one window. */}
      <div className="relative mx-auto max-w-6xl px-6 pb-28 pt-20">
        <ScreensShowcase />
      </div>
    </section>
  );
}
