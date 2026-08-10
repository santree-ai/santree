import { Reveal } from "~/components/reveal";

/** The parallelism proof strip: one bold claim in open space, lit from
 * behind. Honest pre-release framing — no fake metrics. */
export function ParallelStrip() {
  return (
    <section className="relative overflow-hidden py-40">
      <div aria-hidden className="absolute inset-0">
        <div
          className="absolute left-1/2 top-1/2 size-[46rem] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: "radial-gradient(circle, rgba(45,212,167,0.08), transparent 60%)",
          }}
        />
        {/* Five agents, five shards of light — on the artwork's 24° axis. */}
        {[
          { left: "16%", h: 220, a: 0.28, d: "0s" },
          { left: "30%", h: 300, a: 0.42, d: "-3s" },
          { left: "50%", h: 380, a: 0.55, d: "-6s" },
          { left: "68%", h: 300, a: 0.42, d: "-1.5s" },
          { left: "83%", h: 220, a: 0.28, d: "-4.5s" },
        ].map((s) => (
          <span
            key={s.left}
            className="shard top-1/2 -translate-y-1/2"
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
      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <Reveal>
          <h2 className="text-balance text-5xl font-semibold tracking-[-0.03em] sm:text-6xl">
            Run five agents
            <br />
            <span className="text-gradient-emerald">before lunch.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-pretty text-[15px] leading-relaxed text-muted">
            santree schedules nothing for you — it just makes parallel safe. Isolation from git,
            oversight from you.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
