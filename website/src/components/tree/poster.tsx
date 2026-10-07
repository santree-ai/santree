import { boughAt, GROUND, grow, LIGHTS_N, LIMBS, lightLevel, ROOT_Y, rand, swayP, trunkAt } from "./grow";
import { ALL, COLOR, CROWN, heroPose, project, stateAt, type V3, viewOf } from "./model";

/**
 * The hero's first frame, as SVG in the prerendered HTML: the same tree,
 * camera and moment the live scene opens on (grow.ts, model.ts), so the canvas
 * fades in over it. It is also the picture wherever 3D cannot run.
 *
 * The tree is drawn once, in the wide hero's camera, into a <symbol>; the wide
 * and the narrow SVG both <use> it (the narrow one scaled and shifted to the
 * narrow camera's framing), so the HTML carries one tree, not two. A twig is
 * one straight stroke here; the live scene draws its needles.
 *
 * Drawn into a 3:1 box with `slice`: the box scales to the viewport's height
 * and crops its sides, which is how the scene's camera frames (fixed vertical
 * field of view, the target placed in half-heights from the centre). Below
 * 1000 px the scene centres the tree; the poster follows with a CSS shift
 * (.poster in styles.css).
 */

const BW = 3000;
const BH = 1000;

type P = { x: number; y: number; depth: number };

const camera = (wide: boolean) => {
  const POSE = heroPose(wide);
  const VIEW = viewOf(POSE, BW / BH);
  const pt = (p: V3): P => {
    const q = project(VIEW, swayP(p, 0));
    return { x: BW / 2 + (q.x * BW) / 2, y: BH / 2 - (q.y * BH) / 2, depth: q.depth };
  };
  return { POSE, pt };
};

/** Integers: a hairline does not need more, and the HTML carries every digit. */
const n = (v: number) => Math.round(v);

function build() {
  const W = camera(true);
  const g = grow({
    lite: false,
    thin: 1,
    needles: false,
    avoid: ALL.flatMap((b) => [boughAt(b, 1), boughAt(b, 0.6)]),
  });
  const P3 = (i: number): V3 => [
    g.pos[i * 3] as number,
    g.pos[i * 3 + 1] as number,
    g.pos[i * 3 + 2] as number,
  ];

  // A twig is three segments end to end: one stroke from its base to its tip.
  const twigs: { a: P; b: P }[] = [];
  let cur: { a: P; b: P; run: number } | null = null;
  for (let i = 0; i + 1 < g.pos.length / 3; i += 2) {
    if ((g.k[i] as number) === 0) continue; // a spine: drawn whole below
    const a = W.pt(P3(i));
    const b = W.pt(P3(i + 1));
    if (cur && cur.run < 3 && Math.hypot(cur.b.x - a.x, cur.b.y - a.y) < 0.01) {
      cur.b = b;
      cur.run++;
    } else {
      if (cur) twigs.push(cur);
      cur = { a, b, run: 1 };
    }
  }
  if (cur) twigs.push(cur);

  // In three runs by depth, the far side lighter as the scene draws it; relative moves keep the digits few.
  const bins = ["", "", ""];
  const px = [0, 0, 0];
  const py = [0, 0, 0];
  for (const t of twigs) {
    const dep = (t.a.depth + t.b.depth) / 2;
    const bi = dep > W.POSE.dist + 0.7 ? 0 : dep > W.POSE.dist - 0.5 ? 1 : 2;
    const dx = n(t.b.x) - n(t.a.x);
    const dy = n(t.b.y) - n(t.a.y);
    bins[bi] += `m${n(t.a.x) - (px[bi] as number)} ${n(t.a.y) - (py[bi] as number)}l${dx} ${dy}`;
    px[bi] = n(t.a.x) + dx;
    py[bi] = n(t.a.y) + dy;
  }

  let spines = "";
  let sx = 0;
  let sy = 0;
  for (const b of LIMBS) {
    const a0 = W.pt(boughAt(b, 0));
    spines += `m${n(a0.x) - sx} ${n(a0.y) - sy}`;
    sx = n(a0.x);
    sy = n(a0.y);
    for (let i = 1; i <= 4; i++) {
      const p = W.pt(boughAt(b, i / 4));
      spines += `l${n(p.x) - sx} ${n(p.y) - sy}`;
      sx = n(p.x);
      sy = n(p.y);
    }
  }
  let trunk = "";
  for (let y = ROOT_Y; y <= CROWN[1] + 1e-6; y += 0.25) {
    const p = W.pt(trunkAt(y));
    trunk += `${trunk ? "L" : "M"}${n(p.x)} ${n(p.y)}`;
  }
  const bark = g.bark
    .map((l) =>
      l
        .filter((_, i) => i % 3 === 0)
        .map((p, i) => {
          const q = W.pt(p);
          return `${i ? "L" : "M"}${n(q.x)} ${n(q.y)}`;
        })
        .join(""),
    )
    .join("");
  const soil = [0.9, 1.75].map((r) => {
    let d = "";
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const q = W.pt([r * Math.cos(a), GROUND, r * Math.sin(a)]);
      d += `${i ? "L" : "M"}${n(q.x)} ${n(q.y)}`;
    }
    return d;
  });

  const lights = g.lights.map((L, i) => {
    const q = W.pt(L.p);
    return { x: n(q.x), y: n(q.y), lv: lightLevel(L, 0), size: L.size, near: i < LIGHTS_N.lite };
  });

  // the pool of warm light the tree stands in, and the embers at the clock's zero
  const c0 = W.pt([0, GROUND, 0]);
  const pool = {
    x: n(c0.x),
    y: n(c0.y),
    rx: n(Math.abs(W.pt([3.2, GROUND, 0]).x - c0.x)),
    ry: n(Math.abs(W.pt([0, GROUND, 3.2]).y - c0.y)),
  };
  const embers = Array.from({ length: 16 }, (_, i) => {
    const t = g.tips[Math.floor(rand(i, 31) * g.tips.length)] as V3;
    const ph = rand(i, 32);
    const f = (ph * 7) % 1;
    const q = W.pt([
      t[0] + Math.sin(ph * 40) * 0.12,
      t[1] + f * 1.9,
      t[2] + Math.sin(ph * 70) * 0.12,
    ]);
    const a = Math.min(1, f / 0.25) * Math.min(1, (1 - f) / 0.45);
    return { x: n(q.x), y: n(q.y), a: 0.55 * a };
  });

  const LIVE = ALL.map((b) => {
    const st = stateAt(b, b.offset);
    const m = 16;
    const lit =
      st.lit > 0.01
        ? Array.from({ length: m + 1 }, (_, i) => W.pt(boughAt(b, (i / m) * st.grow)))
        : [];
    return {
      b,
      st,
      lit,
      agent: st.stage === "work" ? W.pt(boughAt(b, st.progress)) : null,
      bud: st.bloom > 0.01 ? W.pt(boughAt(b, 1)) : null,
    };
  });

  // The narrow camera frames the same tree smaller and centred: one scale and shift.
  const N = camera(false);
  const ref = (c: typeof W) => [c.pt([0, 0.2, 0]), c.pt([0, 4.1, 0])] as const;
  const [w0, w1] = ref(W);
  const [n0, n1] = ref(N);
  const s = (n0.y - n1.y) / (w0.y - w1.y);
  const narrow = { s, tx: n1.x - w1.x * s, ty: n1.y - w1.y * s };

  return { bins, spines, trunk, bark, soil, lights, LIVE, narrow, pool, embers, crown: W.pt(CROWN) };
}
const T = build();
const d = (ps: { x: number; y: number }[]) =>
  ps.map((p, i) => `${i ? "L" : "M"}${n(p.x)} ${n(p.y)}`).join("");

const VE = "non-scaling-stroke";

function Light({ l }: { l: (typeof T.lights)[number] }) {
  return (
    <>
      <circle cx={l.x} cy={l.y} r={13 + 9 * l.size} fill="url(#tp-halo)" fillOpacity={Math.min(1, 0.45 * l.lv)} />
      <circle cx={l.x} cy={l.y} r={1.8} fill={COLOR.light} fillOpacity={Math.min(1, 0.85 * l.lv)} />
    </>
  );
}

const Tree = () => (
  <symbol id="tree-poster" viewBox={`0 0 ${BW} ${BH}`} overflow="visible">
    <ellipse cx={T.pool.x} cy={T.pool.y} rx={T.pool.rx} ry={T.pool.ry} fill="url(#tp-pool)" />
    {T.embers.map((e, i) => (
      <circle key={i} cx={e.x} cy={e.y} r={1.3} fill={COLOR.light} fillOpacity={e.a} />
    ))}
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {T.soil.map((p) => (
        <path
          key={p}
          d={p}
          stroke={COLOR.ink}
          strokeOpacity={0.07}
          strokeWidth={0.8}
          vectorEffect={VE}
        />
      ))}
      <g stroke="#8fc4ad" strokeWidth={0.8}>
        {T.bins.map((b, i) => (
          <path key={i} d={b} strokeOpacity={[0.26, 0.38, 0.52][i]} vectorEffect={VE} />
        ))}
      </g>
      <g stroke="#d4dcd7">
        <path d={T.spines} strokeOpacity={0.3} strokeWidth={0.8} vectorEffect={VE} />
        <path d={T.bark} strokeOpacity={0.28} strokeWidth={0.7} vectorEffect={VE} />
        <path d={T.trunk} strokeOpacity={0.5} strokeWidth={1.2} vectorEffect={VE} />
      </g>
      <g stroke={COLOR.ink} strokeWidth={1.1}>
        {T.LIVE.map(({ b, st, lit }) =>
          lit.length > 1 ? (
            <path key={b.id} d={d(lit)} strokeOpacity={0.6 * st.lit} vectorEffect={VE} />
          ) : null,
        )}
      </g>
    </g>
    {T.lights
      .filter((l) => l.near)
      .map((l, i) => (
        <Light key={i} l={l} />
      ))}
    {T.LIVE.map(({ b, st, agent, bud }) => {
      const hue = st.asking ? COLOR.ask : COLOR.agent;
      return (
        <g key={b.id}>
          {agent && (
            <>
              <circle cx={n(agent.x)} cy={n(agent.y)} r={12} fill={hue} fillOpacity={0.08} />
              {st.asking && (
                <circle
                  cx={n(agent.x)}
                  cy={n(agent.y)}
                  r={8.5}
                  fill="none"
                  stroke={hue}
                  strokeWidth={0.9}
                  strokeOpacity={0.55}
                />
              )}
              <circle cx={n(agent.x)} cy={n(agent.y)} r={2.3} fill={hue} />
            </>
          )}
          {bud && (
            <>
              <circle
                cx={n(bud.x)}
                cy={n(bud.y)}
                r={5.5}
                fill="none"
                stroke={COLOR.open}
                strokeWidth={0.9}
                strokeOpacity={0.6 * st.bloom}
              />
              <circle
                cx={n(bud.x)}
                cy={n(bud.y)}
                r={1.7}
                fill={COLOR.open}
                fillOpacity={st.bloom}
              />
            </>
          )}
        </g>
      );
    })}
    <circle cx={n(T.crown.x)} cy={n(T.crown.y)} r={11} fill={COLOR.accent} fillOpacity={0.1} />
    <circle
      cx={n(T.crown.x)}
      cy={n(T.crown.y)}
      r={6}
      fill="none"
      stroke={COLOR.accent}
      strokeWidth={0.9}
      strokeOpacity={0.4}
    />
    <circle cx={n(T.crown.x)} cy={n(T.crown.y)} r={2.1} fill={COLOR.accent} />
  </symbol>
);

export function TreePoster({ className }: { className?: string }) {
  const nr = T.narrow;
  return (
    <>
      <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
        <defs>
          <radialGradient id="tp-halo">
            <stop offset="0" stopColor={COLOR.light} stopOpacity={0.9} />
            <stop offset="0.35" stopColor={COLOR.light} stopOpacity={0.3} />
            <stop offset="1" stopColor={COLOR.light} stopOpacity={0} />
          </radialGradient>
          <radialGradient id="tp-pool">
            <stop offset="0" stopColor={COLOR.light} stopOpacity={0.06} />
            <stop offset="1" stopColor={COLOR.light} stopOpacity={0} />
          </radialGradient>
          <Tree />
        </defs>
      </svg>
      <svg
        viewBox={`0 0 ${BW} ${BH}`}
        preserveAspectRatio="xMidYMid slice"
        className={`${className ?? ""} poster-wide`}
        aria-hidden
      >
        <use href="#tree-poster" width={BW} height={BH} />
        {T.lights
          .filter((l) => !l.near)
          .map((l, i) => (
            <Light key={i} l={l} />
          ))}
      </svg>
      <svg
        viewBox={`0 0 ${BW} ${BH}`}
        preserveAspectRatio="xMidYMid slice"
        className={`${className ?? ""} poster-narrow`}
        aria-hidden
      >
        <use
          href="#tree-poster"
          width={BW}
          height={BH}
          opacity={0.8}
          transform={`translate(${n(nr.tx)} ${n(nr.ty)}) scale(${nr.s.toFixed(4)})`}
        />
      </svg>
    </>
  );
}
