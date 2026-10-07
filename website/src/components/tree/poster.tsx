import {
  ALL,
  boughAt,
  COLOR,
  CONES,
  CROWN,
  heroPose,
  LINE,
  project,
  stateAt,
  type V3,
  viewOf,
} from "./model";

/**
 * The hero's first frame, as SVG in the prerendered HTML: the same line,
 * camera and moment the live scene opens on (model.ts), so the canvas fades
 * in over it stroke for stroke. It is also the picture wherever 3D cannot run.
 *
 * Drawn into a 3:1 box with `slice`: the box scales to the viewport's height
 * and crops its sides, which is how the scene's camera frames (fixed vertical
 * field of view, the target placed in half-heights from the centre). Below
 * 1000 px the scene centres the tree; the poster follows with a CSS shift
 * (.poster in styles.css).
 */

const BW = 3000;
const BH = 1000;
const r1 = (n: number) => Math.round(n * 2) / 2;

type P = { x: number; y: number };

/** Convex hull (monotone chain) of projected points: a cone's silhouette. */
function hull(ps: P[]): P[] {
  const s = [...ps].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: P[] = [];
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2] as P, lo[lo.length - 1] as P, p) <= 0)
      lo.pop();
    lo.push(p);
  }
  const up: P[] = [];
  for (const p of [...s].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2] as P, up[up.length - 1] as P, p) <= 0)
      up.pop();
    up.push(p);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

function poster(wide: boolean) {
  const POSE = heroPose(wide);
  const VIEW = viewOf(POSE, BW / BH);

  function pt(p: V3) {
    const q = project(VIEW, p);
    return { x: BW / 2 + (q.x * BW) / 2, y: BH / 2 - (q.y * BH) / 2, depth: q.depth };
  }

  /** The line in runs by depth: the far side lighter, as the scene draws it. */
  const RUNS = (() => {
    const runs: { d: string; o: number }[] = [];
    const op = [0.13, 0.3, 0.5];
    let cur = "";
    let bin = -1;
    for (let i = 0; i < LINE.pts.length; i += 5) {
      const p = pt(LINE.pts[i] as V3);
      const b = p.depth > POSE.dist + 0.6 ? 0 : p.depth > POSE.dist - 0.4 ? 1 : 2;
      if (b !== bin) {
        if (cur) runs.push({ d: cur, o: op[bin] as number });
        cur = `M${r1(p.x)} ${r1(p.y)}`;
        bin = b;
      } else cur += `L${r1(p.x)} ${r1(p.y)}`;
    }
    if (cur) runs.push({ d: cur, o: op[bin] as number });
    return runs;
  })();

  const BODIES = CONES.map((c) => {
    const ring: P[] = Array.from({ length: 48 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2;
      return pt([c.r * Math.cos(a), c.base, c.r * Math.sin(a)]);
    });
    const h = hull([...ring, pt([0, c.apex, 0])]);
    return h.map((p, i) => `${i ? "L" : "M"}${r1(p.x)} ${r1(p.y)}`).join("") + "Z";
  });

  const LIVE = ALL.map((b) => {
    const st = stateAt(b, b.offset);
    const n = 24;
    const lit =
      st.lit > 0.01
        ? Array.from({ length: n + 1 }, (_, i) => pt(boughAt(b, (i / n) * st.grow)))
        : [];
    return {
      b,
      st,
      lit,
      agent: st.stage === "work" ? pt(boughAt(b, st.progress)) : null,
      bud: st.bloom > 0.01 ? pt(boughAt(b, 1)) : null,
    };
  });
  const CROWN_P = pt(CROWN);
  return { RUNS, LIVE, CROWN_P, BODIES };
}
const POSTERS = { wide: poster(true), narrow: poster(false) };
const d = (ps: { x: number; y: number }[]) =>
  ps.map((p, i) => `${i ? "L" : "M"}${r1(p.x)} ${r1(p.y)}`).join("");

export function TreePoster({ className }: { className?: string }) {
  return (
    <>
      <PosterSvg className={`${className ?? ""} poster-wide`} p={POSTERS.wide} />
      <PosterSvg className={`${className ?? ""} poster-narrow`} p={POSTERS.narrow} />
    </>
  );
}

function PosterSvg({ className, p }: { className: string; p: (typeof POSTERS)["wide"] }) {
  const { RUNS, LIVE, CROWN_P, BODIES } = p;
  return (
    <svg
      viewBox={`0 0 ${BW} ${BH}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      aria-hidden
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {BODIES.map((b) => (
        <path key={b} d={b} fill={COLOR.accent} fillOpacity={0.035} />
      ))}
      <g stroke={COLOR.ink} strokeWidth={0.9}>
        {RUNS.map((r, i) => (
          <path key={i} d={r.d} strokeOpacity={r.o} />
        ))}
        {LIVE.map(({ b, st, lit }) =>
          lit.length > 1 ? (
            <path key={b.id} d={d(lit)} strokeOpacity={0.6 * st.lit} strokeWidth={1.1} />
          ) : null,
        )}
      </g>
      {LIVE.map(({ b, st, agent, bud }) => {
        const hue = st.asking ? COLOR.ask : COLOR.agent;
        return (
          <g key={b.id}>
            {agent && (
              <>
                <circle cx={agent.x} cy={agent.y} r={12} fill={hue} fillOpacity={0.08} />
                {st.asking && (
                  <circle
                    cx={agent.x}
                    cy={agent.y}
                    r={8.5}
                    stroke={hue}
                    strokeWidth={0.9}
                    strokeOpacity={0.55}
                  />
                )}
                <circle cx={agent.x} cy={agent.y} r={2.3} fill={hue} />
              </>
            )}
            {bud && (
              <>
                <circle
                  cx={bud.x}
                  cy={bud.y}
                  r={5.5}
                  stroke={COLOR.open}
                  strokeWidth={0.9}
                  strokeOpacity={0.6 * st.bloom}
                />
                <circle cx={bud.x} cy={bud.y} r={1.7} fill={COLOR.open} fillOpacity={st.bloom} />
              </>
            )}
          </g>
        );
      })}
      <circle cx={CROWN_P.x} cy={CROWN_P.y} r={11} fill={COLOR.accent} fillOpacity={0.1} />
      <circle
        cx={CROWN_P.x}
        cy={CROWN_P.y}
        r={6}
        stroke={COLOR.accent}
        strokeWidth={0.9}
        strokeOpacity={0.4}
      />
      <circle cx={CROWN_P.x} cy={CROWN_P.y} r={2.1} fill={COLOR.accent} />
    </svg>
  );
}
