import { DownloadButton } from "~/components/download-button";
import { HeroArt } from "~/components/hero/hero-art";
import { GitHubLogo } from "~/components/icons";
import { ScreenshotFrame } from "~/components/ui/screenshot-frame";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* The hero artwork: a baked composition (emerald light shards echoing
          the mark's stacked triangles), rendered once at 2x and shipped as a
          static image — the same technique Raycast uses for its hero. The
          page-wide grain overlay adds the film texture on top; HeroArt adds
          scroll/pointer parallax. */}
      <div aria-hidden className="absolute inset-x-0 top-0 flex justify-center">
        <HeroArt />
        {/* Scrim: seats the text in a darker pocket of the artwork. Static —
            it must not move with the parallax. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 58% 52% at 50% 52%, rgba(7,8,10,0.78), rgba(7,8,10,0.25) 62%, transparent 80%)",
          }}
        />
      </div>

      <div className="hero-text relative mx-auto max-w-3xl px-6 pt-44 text-center sm:pt-52">
        <h1 className="rise text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[4.5rem]">
          Your backlog,
          <br />
          <span className="text-gradient-emerald">shipped in parallel.</span>
        </h1>
        <p className="rise rise-1 mx-auto mt-7 max-w-xl text-pretty text-[17px] leading-relaxed text-[#c9cad2]">
          santree is a desktop app for running Claude agents across your repo's tickets — each one
          in an isolated git worktree you can watch, steer, and merge.
        </p>
        <div className="rise rise-2 mt-10 flex flex-wrap items-center justify-center gap-3">
          <DownloadButton size="lg" />
          <a href="https://github.com/santree-ai/santree" className="btn btn-ghost h-11 px-5">
            <GitHubLogo size={15} />
            Star on GitHub
          </a>
        </div>
        <p className="rise rise-3 mt-7 font-mono text-[11px] tracking-wide text-[#8f9099]">
          macOS · Linux · open source · bring your own Claude
        </p>
      </div>

      {/* The hero shot: the Trees view slot. Still, centered, deep shadow. */}
      <div className="relative mx-auto max-w-5xl px-6 pb-28 pt-24">
        <ScreenshotFrame view="trees" />
      </div>
    </section>
  );
}
