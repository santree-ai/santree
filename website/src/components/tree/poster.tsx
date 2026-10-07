import {
  ALL,
  boughAt,
  COLOR,
  CROWN,
  heroPose,
  LINE,
  lineAt,
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
    let cur = "";
    let bin = -1;
    for (let i = 0; i < LINE.pts.length; i += 3) {
      const p = pt(LINE.pts[i]!);
      const b = p.depth > POSE.dist + 0.6 ? 0 : p.depth > POSE.dist - 0.4 ? 1 : 2;
      if (b !== bin) {
        if (cur) runs.push({ d: cur, o: [0.16, 0.34, 0.62][bin]! });
        cur = `M${r1(p.x)} ${r1(p.y)}`;
        bin = b;
      } else cur += `L${r1(p.x)} ${r1(p.y)}`;
    }
    if (cur) runs.push({ d: cur, o: [0.16, 0.34, 0.62][bin]! });
    return runs;
  })();

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
      bead: st.bead >= 0 ? pt(lineAt(st.bead)) : null,
    };
  });
  const CROWN_P = pt(CROWN);
  return { RUNS, LIVE, CROWN_P };
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
  const { RUNS, LIVE, CROWN_P } = p;
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
      <g stroke={COLOR.ink} strokeWidth={1.1}>
        {RUNS.map((r, i) => (
          <path key={i} d={r.d} strokeOpacity={r.o} />
        ))}
        {LIVE.map(({ b, st, lit }) =>
          lit.length > 1 ? (
            <path key={b.id} d={d(lit)} strokeOpacity={0.9 * st.lit} strokeWidth={1.7} />
          ) : null,
        )}
      </g>
      {LIVE.map(({ b, st, agent, bud, bead }) => {
        const hue = st.asking
          ? COLOR.permission
          : b.agent === "claude"
            ? COLOR.claude
            : COLOR.codex;
        const budHue = st.stage === "merged" || st.stage === "back" ? COLOR.merged : COLOR.open;
        return (
          <g key={b.id}>
            {agent && (
              <>
                <circle cx={agent.x} cy={agent.y} r={20} fill={hue} fillOpacity={0.18} />
                <circle cx={agent.x} cy={agent.y} r={3.6} fill={hue} />
              </>
            )}
            {bud && (
              <>
                <circle
                  cx={bud.x}
                  cy={bud.y}
                  r={8}
                  stroke={budHue}
                  strokeWidth={1.3}
                  strokeOpacity={st.bloom}
                />
                <circle cx={bud.x} cy={bud.y} r={2.8} fill={budHue} fillOpacity={st.bloom} />
              </>
            )}
            {bead && <circle cx={bead.x} cy={bead.y} r={3.4} fill={COLOR.triage} />}
          </g>
        );
      })}
      <circle cx={CROWN_P.x} cy={CROWN_P.y} r={18} fill={COLOR.accent} fillOpacity={0.16} />
      <circle cx={CROWN_P.x} cy={CROWN_P.y} r={3.4} fill={COLOR.accent} />
    </svg>
  );
}
