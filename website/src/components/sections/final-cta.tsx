import { useState } from "react";
import { GitHubLogo } from "~/components/icons";
import { FadeUp } from "~/components/motion/fade-up";

const CLONE = "git clone https://github.com/santree-ai/santree.git";

/** Closing CTA: the open-source pitch over light rising from below the
 * horizon — the shard language from the parallel strip, closing the page
 * the way the aurora opened it. */
export function FinalCta() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CLONE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the text is
      // selectable either way.
    }
  };

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
            santree is open source under the MIT license. Star the repo to follow along, or watch
            releases to catch the first public build.
          </p>
        </FadeUp>
        <FadeUp delay={0.08}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a href="https://github.com/santree-ai/santree" className="btn btn-primary h-11 px-5">
              <GitHubLogo size={15} />
              Star on GitHub
            </a>
            <a
              href="https://github.com/santree-ai/santree/releases"
              className="btn btn-ghost h-11 px-5"
            >
              Watch releases
            </a>
          </div>
        </FadeUp>
        <FadeUp delay={0.14}>
          <div className="card mx-auto mt-12 flex max-w-md items-center justify-between gap-3 px-4 py-3">
            <code className="select-all overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-muted">
              {CLONE}
            </code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-md px-2 py-1 font-mono text-[11px] text-muted-4 transition-colors hover:bg-white/5 hover:text-accent"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </FadeUp>
      </div>
    </section>
  );
}
