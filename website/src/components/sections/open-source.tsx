import { useState } from "react";
import { GitHubLogo } from "~/components/icons";
import { Reveal } from "~/components/reveal";

const CLONE = "git clone https://github.com/santree-ai/santree.git";

/** Closing CTA: open-source pitch over a soft floor glow, with a copyable
 * clone line. */
export function OpenSource() {
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
      {/* The hero artwork returns, mirrored — light rising from below the
          horizon to close the page the way it opened. */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 flex justify-center overflow-hidden">
        <img
          src="/hero-art.jpg"
          alt=""
          width={2400}
          height={1600}
          loading="lazy"
          draggable={false}
          className="w-[1500px] max-w-none flex-none -scale-y-100 select-none opacity-60"
          style={{
            maskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 78%)",
            WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 78%)",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-2xl px-6 text-center">
        <Reveal>
          <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[2.75rem]">
            All branches merge eventually.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-muted">
            santree is open source under the MIT license. Star the repo to follow along, or watch
            releases to catch the first public build.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
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
        </Reveal>
        <Reveal delay={0.14}>
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
        </Reveal>
      </div>
    </section>
  );
}
