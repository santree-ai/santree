import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import { FadeUp } from "~/components/motion/fade-up";

/** Closing CTA: the open-source pitch over light rising from below the
 * horizon — the shard language from the parallel strip, closing the page
 * the way the aurora opened it.
 *
 * The action here is the same one the nav and hero offer: download. The
 * repo link is secondary because reading the source is a real thing people
 * do, not because a star is worth asking for. (This section used to lead
 * with "Star on GitHub" over a `git clone` box — correct when building
 * from source was the only way to run santree, wrong since the app ships
 * a signed DMG that updates itself.) */
export function FinalCta() {
  return (
    <section id="oss" className="relative scroll-mt-28 overflow-hidden py-36">
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[26rem]">
        {/* Floor bloom */}
        <div
          className="absolute inset-x-0 -bottom-40 h-[30rem]"
          style={{
            background:
              "radial-gradient(ellipse 60% 55% at 50% 100%, rgba(45,212,167,0.14), rgba(31,156,125,0.05) 55%, transparent 75%)",
          }}
        />
        {/* Light rising from below the horizon, on the 24° axis. */}
        {[
          { left: "22%", h: 200, a: 0.2, d: "-2s" },
          { left: "38%", h: 280, a: 0.32, d: "-5s" },
          { left: "55%", h: 340, a: 0.4, d: "0s" },
          { left: "71%", h: 260, a: 0.3, d: "-3.5s" },
          { left: "85%", h: 190, a: 0.2, d: "-7s" },
        ].map((s) => (
          <span
            key={s.left}
            className="shard bottom-0"
            style={
              {
                left: s.left,
                height: s.h,
                "--shard-a": s.a,
                animationDelay: s.d,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <div className="relative mx-auto max-w-2xl px-6 text-center">
        <FadeUp>
          <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[2.75rem]">
            All branches merge eventually.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-muted">
            santree is open source under the MIT license — every line of the app you'd be running.
            Take it for what it is: a way to keep five agents honest.
          </p>
        </FadeUp>
        <FadeUp delay={0.08}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <DownloadButton size="lg" />
            <a href="https://github.com/santree-ai/santree" className="btn btn-ghost h-11 px-5">
              <GitHubLogo size={15} />
              Read the source
            </a>
          </div>
        </FadeUp>
        <FadeUp delay={0.14}>
          <p className="mt-8 font-mono text-[11.5px] tracking-wide text-muted-4">
            MIT licensed · signed &amp; notarized · updates itself
          </p>
        </FadeUp>
      </div>
    </section>
  );
}
