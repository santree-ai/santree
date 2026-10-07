import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import { FadeUp } from "~/components/motion/fade-up";

/** Closing CTA. The log's graph comes back as the bookend: three branches
 * folding into one trunk above the line that names it. Same lane strokes and
 * draw-in as the log (`.log-lane` in styles.css). */
function Merge() {
  const branch = "rgba(255, 255, 255, 0.2)";
  return (
    <svg
      viewBox="0 0 120 120"
      width={120}
      height={120}
      className="log-bookend mx-auto overflow-visible"
      aria-hidden
    >
      {[18, 102].map((x) => (
        <path
          key={x}
          className="log-lane"
          pathLength={1}
          d={`M${x} 0 V30 C${x} 62 60 52 60 80`}
          fill="none"
          stroke={branch}
          strokeWidth={1.2}
        />
      ))}
      <path
        className="log-lane"
        pathLength={1}
        d="M60 0 V112"
        fill="none"
        stroke="rgba(45, 212, 167, 0.55)"
        strokeWidth={1.6}
      />
      <circle cx={60} cy={80} r={4.5} fill="#a78bfa" />
      <circle cx={60} cy={112} r={4.5} fill="#2dd4a7" />
    </svg>
  );
}

export function FinalCta() {
  return (
    <section id="download" className="relative scroll-mt-20 overflow-hidden pb-36 pt-8">
      <div
        aria-hidden
        className="absolute inset-x-0 -bottom-40 h-[30rem]"
        style={{
          background:
            "radial-gradient(ellipse 60% 55% at 50% 100%, rgba(45,212,167,0.13), rgba(31,156,125,0.05) 55%, transparent 75%)",
        }}
      />
      <div className="relative mx-auto max-w-2xl px-6 text-center">
        <Merge />
        <FadeUp>
          <h2 className="mt-10 text-balance text-[clamp(2.25rem,1.5rem+3vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em]">
            All branches merge eventually.
          </h2>
          <p className="mx-auto mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-muted">
            santree is free and MIT licensed. Point it at a repo and run your first ticket.
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
      </div>
    </section>
  );
}
