/**
 * santree's tree, grown: a conifer from a seed, as numbers (no three.js).
 *
 * The recipe is the one real firs follow, kept small:
 * - a leader up the middle that leans a hair and tapers;
 * - whorls of primary branches up it, each a few branches around, turned a
 *   golden angle from the last so no two whorls stack, with jitter on
 *   everything so nothing repeats;
 * - a branch's length follows a cone envelope. There are two cones, santree's
 *   mark: a wide lower tier and a narrower upper one, with the notch between
 *   them where the leader shows. The icon survives as the silhouette;
 * - branches rise a little off the trunk, then sag under their own weight,
 *   the lower ones more, and flick up at the very end;
 * - each branch carries a flat spray: twigs off both sides, longest near the
 *   trunk and shorter toward the tip (a frond), each with a few needles.
 *
 * Deterministic: the server, the poster and every browser grow the same tree.
 * Meters, y up, the soil line at GROUND.
 */

export type V3 = [number, number, number];

const deg = (d: number) => (d * Math.PI) / 180;
export const TAU = Math.PI * 2;

/** Deterministic noise, so the server and every client grow the same tree. */
export function rand(i: number, salt = 0) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = (x: number) => x * x * (3 - 2 * x);

// ——— the two tiers: the app icon's two triangles, as envelopes ———

/** Logo units to meters: the mark's 256 units of height are 3.8 m of tree. */
const LS = 3.8 / 256;
export const TOP = 4.15;
export interface Cone {
  apex: number;
  base: number;
  r: number;
}
export const CONES: readonly [Cone, Cone] = [
  { apex: TOP, base: TOP - 104 * LS, r: 83 * LS },
  { apex: TOP - 120 * LS, base: TOP - 256 * LS, r: 108 * LS },
];
const [UPPER, LOWER] = CONES;
export const CROWN: V3 = [0, TOP + 0.08, 0];
/** The soil line, and where the taproot starts under the ledger's last row. */
export const GROUND = 0.1;
export const ROOT_Y = -0.95;

const coneR = (c: Cone, y: number) => Math.max(0, (c.r * (c.apex - y)) / (c.apex - c.base));

// ——— the leader ———

/** The trunk's axis at height y: a slow lean, never a ruler. */
export function trunkAt(y: number): V3 {
  const k = Math.min(1, Math.max(0, y) / TOP);
  return [0.07 * Math.sin(1.1 * y + 0.4) * k, y, 0.05 * Math.sin(0.8 * y + 2.1) * k];
}

/** The trunk's radius: a flare at the soil, a slow taper, a needle at the top. */
export function trunkR(y: number) {
  if (y < GROUND) return 0.075 + 0.07 * clamp01((GROUND - y) / 0.5);
  return 0.012 + 0.063 * (1 - clamp01((y - GROUND) / (TOP - GROUND))) ** 1.25;
}

// ——— a bough: one primary branch ———

export interface Limb {
  /** Where it leaves the trunk, and its bearing (outward). */
  fork: V3;
  phi: number;
  /** Reach, sag as a share of reach, and how far it curls sideways. */
  len: number;
  sag: number;
  curl: number;
}

/**
 * Out from the fork, s 0..1: up a little, then the sag of a fir (the lower the
 * branch, the more), curling sideways with the wind, and a flick at the tip.
 */
export function boughAt(b: Limb, s: number): V3 {
  const ph = b.phi + b.curl * s * s;
  const rho = b.len * s;
  const flick = 0.07 * clamp01((s - 0.8) / 0.2) ** 2;
  const y = b.fork[1] + b.len * (0.16 * s - (0.16 + b.sag) * s ** 1.7 + flick);
  return [b.fork[0] + rho * Math.cos(ph), y, b.fork[2] - rho * Math.sin(ph)];
}

function buildLimbs(): Limb[] {
  const out: Limb[] = [];
  let az = deg(20);
  let i = 0;
  const tier = (c: Cone, y0: number, y1: number, gap: number, nTop: number, nBot: number) => {
    let y = y0;
    while (y < y1) {
      const k = clamp01((y - y0) / (y1 - y0));
      const n = Math.max(3, Math.round(nBot + (nTop - nBot) * k + (rand(i, 3) - 0.5) * 1.6));
      az += deg(137.5 + 24 * (rand(i, 4) - 0.5));
      for (let j = 0; j < n; j++) {
        const phi = az + (j / n) * TAU + deg(30) * (rand(i * 7 + j, 5) - 0.5);
        const R = coneR(c, y) * (1.1 + 0.22 * rand(i * 7 + j, 6));
        const len = Math.max(0.2, R);
        out.push({
          fork: trunkAt(y + 0.03 * (rand(i * 7 + j, 8) - 0.5)),
          phi,
          len,
          // lower boughs sag more; a little each way
          sag: (0.12 + 0.19 * (1 - k * 0.65) * (c === LOWER ? 1 : 0.95)) * (0.8 + 0.4 * rand(i * 7 + j, 7)),
          curl: deg(34) * (rand(i * 7 + j, 9) - 0.5),
        });
      }
      i++;
      y += gap * (0.8 + 0.4 * rand(i, 10));
    }
  };
  tier(LOWER, 0.6, LOWER.apex - 0.04, 0.088, 5, 7);
  tier(UPPER, UPPER.base + 0.03, UPPER.apex - 0.1, 0.076, 4, 6);
  return out;
}

export const LIMBS: Limb[] = buildLimbs();

/** The limb nearest a height and a bearing: how the ticket boughs are chosen. */
export function limbNear(y: number, phi: number): Limb {
  let best = LIMBS[0] as Limb;
  let d = Number.POSITIVE_INFINITY;
  for (const l of LIMBS) {
    const dp = Math.atan2(Math.sin(l.phi - phi), Math.cos(l.phi - phi));
    const e = Math.abs(l.fork[1] - y) * 2 + Math.abs(dp);
    if (e < d) {
      d = e;
      best = l;
    }
  }
  return best;
}

// ——— the wind ———

/**
 * How far the wind has moved a point, t seconds in. A function of position and
 * time alone, so the vertex stage (engine.ts) and every light, label and
 * leader the page sets on the scene compute the same number. Slow (a period of
 * twelve seconds), small, and zero on the trunk's axis.
 */
export function sway(p: V3, t: number): V3 {
  const [x, y, z] = p;
  const r = Math.hypot(x, z);
  const k = 0.03 * r * (0.5 + 0.5 * (Math.max(0, y) / TOP));
  return [
    k * Math.sin(0.5 * t + 0.9 * y + 0.7 * z),
    0.3 * k * Math.sin(0.5 * t + 0.9 * y + 0.7 * z + 1.2),
    0.7 * k * Math.sin(0.42 * t + 0.8 * y + 1.1 * x + 1.7),
  ];
}
export const swayP = (p: V3, t: number): V3 => {
  const d = sway(p, t);
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
};

// ——— the lights: tickets resting on the branches ———

export interface Light {
  p: V3;
  /** Breath: phase (rad) and period (s). Every light's own; no two alike. */
  ph: number;
  per: number;
  /** When, in LIGHT_LOOP seconds, work lands on it and it brightens. */
  tl: number;
  /** Size, 0..1. */
  size: number;
}

/** A landing comes round once per this many seconds, per light: with two dozen lights, one every ten or so. */
export const LIGHT_LOOP = 300;

/**
 * How lit a light is at wall time t, 0..~1.5: a long, eased, low breath (never
 * a blink), plus the slow swell and settle of work landing on its branch.
 * Mirrored in the vertex stage (engine.ts).
 */
export function lightLevel(L: Pick<Light, "ph" | "per" | "tl">, t: number) {
  const x = 0.5 + 0.5 * Math.sin((TAU * t) / L.per + L.ph);
  const breath = 0.58 + 0.3 * ease(x);
  const u = (((t - L.tl) % LIGHT_LOOP) + LIGHT_LOOP) % LIGHT_LOOP;
  const bump = ease(clamp01(u / 5)) * Math.exp(-Math.max(0, u - 5) / 25);
  return breath + 0.9 * bump;
}

// ——— the geometry ———

export interface Grown {
  /** Segment endpoints, xyz, two per segment. */
  pos: Float32Array;
  /** Per vertex: brightness, 0 = wood .. 1 = needle (tint), and the nearest light's reach and phase/period/landing. */
  a: Float32Array;
  k: Float32Array;
  lt: Float32Array;
  lights: Light[];
  /** Twig tips, for the embers to rise from. */
  tips: V3[];
  /** The soil's contour rings and the roots are drawn separately: the roots, as polylines. */
  roots: V3[][];
  /** The trunk's bark: polylines along it. */
  bark: V3[][];
}

const add3 = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export interface GrowOpts {
  /** Fewer twigs and needles for phones and weak GPUs. */
  lite: boolean;
  /** Keep lights off these points (the ticket boughs' own). */
  avoid?: V3[];
  /** Draw needles (the poster does not). */
  needles?: boolean;
  /** Keep every n-th twig only (the poster's thinning). */
  thin?: number;
}

/** How many lights rest on the branches, by device. */
export const LIGHTS_N = { full: 18, lite: 11 } as const;

export function grow(o: GrowOpts): Grown {
  const pos: number[] = [];
  const A: number[] = [];
  const K: number[] = [];
  const tips: V3[] = [];
  const cands: V3[] = [];
  const needles = o.needles ?? true;
  const thin = Math.max(1, o.thin ?? 1);

  const seg = (p: V3, q: V3, a0: number, a1: number, k: number) => {
    pos.push(p[0], p[1], p[2], q[0], q[1], q[2]);
    A.push(a0, a1);
    K.push(k, k);
  };

  let twigId = 0;
  LIMBS.forEach((b, bi) => {
    // the spine
    const S = 9;
    let prev = boughAt(b, 0);
    for (let i = 1; i <= S; i++) {
      const q = boughAt(b, i / S);
      seg(prev, q, 0.5 * (1 - 0.5 * ((i - 1) / S)), 0.5 * (1 - 0.5 * (i / S)), 0);
      prev = q;
    }
    // a frond: twigs off both sides, longest near the trunk
    const n = Math.max(3, Math.round(b.len * 9));
    for (let i = 1; i <= n; i++) {
      const s = 0.1 + 0.88 * ((i - 0.5 + 0.4 * (rand(bi * 31 + i, 11) - 0.5)) / n);
      const p = boughAt(b, s);
      const T = norm3(sub3(boughAt(b, Math.min(1, s + 0.03)), p));
      let side = cross3([0, 1, 0], T);
      if (Math.hypot(...side) < 1e-3) side = [1, 0, 0];
      side = norm3(side);
      const up = norm3(cross3(T, side));
      for (const sg of [-1, 1] as const) {
        const id = twigId++;
        const base = 0.36 * b.len * (1 - 0.8 * s) * (0.82 + 0.36 * rand(id, 12));
        const lt = Math.min(0.55, Math.max(0.07, base));
        const ang = deg(50 + 22 * rand(id, 13));
        const dir = norm3([
          T[0] * Math.cos(ang) + side[0] * sg * Math.sin(ang) - up[0] * (0.14 + 0.12 * rand(id, 14)),
          T[1] * Math.cos(ang) + side[1] * sg * Math.sin(ang) - up[1] * (0.14 + 0.12 * rand(id, 14)),
          T[2] * Math.cos(ang) + side[2] * sg * Math.sin(ang) - up[2] * (0.14 + 0.12 * rand(id, 14)),
        ]);
        const pts: V3[] = [p];
        for (let k = 1; k <= 3; k++) {
          const f = k / 3;
          pts.push([
            p[0] + dir[0] * lt * f + T[0] * lt * 0.3 * f * f,
            p[1] + dir[1] * lt * f + T[1] * lt * 0.3 * f * f - lt * 0.22 * f * f,
            p[2] + dir[2] * lt * f + T[2] * lt * 0.3 * f * f,
          ]);
        }
        const tip = pts[3] as V3;
        cands.push(tip);
        if (id % thin) continue;
        tips.push(tip);
        const w = 0.2 + 0.14 * rand(id, 15);
        for (let k = 1; k <= 3; k++)
          seg(pts[k - 1] as V3, pts[k] as V3, w * (1 - (k - 1) / 4), w * (1 - k / 4), 0.35 + 0.1 * k);
        if (needles) {
          const inPlane = norm3(cross3(dir, up));
          for (let k = 1; k <= 3; k++) {
            if (o.lite && k === 2) continue;
            const q = pts[k] as V3;
            for (const s2 of [-1, 1]) {
              const nl = 0.045 + 0.04 * rand(id * 5 + k * 2 + s2, 16);
              const nd = norm3([
                dir[0] * 0.55 + inPlane[0] * s2 * 0.8 + up[0] * 0.25,
                dir[1] * 0.55 + inPlane[1] * s2 * 0.8 + up[1] * 0.25,
                dir[2] * 0.55 + inPlane[2] * s2 * 0.8 + up[2] * 0.25,
              ]);
              seg(q, add3(q, nd, nl), 0.24, 0.04, 1);
            }
          }
        }
      }
    }
    // the tip: three short shoots fanning from the end
    const e = boughAt(b, 1);
    const T = norm3(sub3(e, boughAt(b, 0.93)));
    for (let j = -1; j <= 1; j++) {
      const id = twigId++;
      const d = norm3([T[0] + 0.5 * j * -T[2], T[1] - 0.05, T[2] + 0.5 * j * T[0]]);
      const q = add3(e, d, 0.1 + 0.05 * rand(id, 17));
      cands.push(q);
      if (id % thin) continue;
      seg(e, q, 0.24, 0.08, 0.7);
    }
  });

  // the leader: the trunk's own lines, and the top shoot
  const bark: V3[][] = [];
  for (let j = 0; j < 5; j++) {
    const a = (j / 5) * TAU + 0.6;
    const line: V3[] = [];
    for (let i = 0; i <= 30; i++) {
      const y = -0.35 + ((TOP + 0.02 - -0.35) * i) / 30;
      const c = trunkAt(y);
      const r = trunkR(y);
      const tw = a + y * 0.5;
      line.push([c[0] + r * Math.cos(tw), y, c[2] + r * Math.sin(tw)]);
    }
    bark.push(line);
  }
  // roots: out and down from the flare, thinning into the dark
  const roots: V3[][] = [];
  for (let j = 0; j < 7; j++) {
    const a = (j / 7) * TAU + 0.4 + 0.5 * rand(j, 18);
    const L = 0.9 + 0.9 * rand(j, 19);
    const line: V3[] = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const rr = 0.1 + L * s;
      const aa = a + 0.5 * s * s * (rand(j, 20) - 0.5) * 2;
      line.push([rr * Math.cos(aa), GROUND - 0.04 - 0.85 * s ** 0.8 - 0.1 * s, -rr * Math.sin(aa)]);
    }
    roots.push(line);
  }

  // the lights rest on the tips of twigs: spread out, off the trunk, off the boughs' own
  const lights: Light[] = [];
  const want = o.lite ? LIGHTS_N.lite : LIGHTS_N.full;
  // spread through the height, not through the volume: a band of the tree each
  const BAND = (3.95 - 0.8) / LIGHTS_N.full;
  const order = cands
    .map((p, i) => ({ p, i, r: rand(i, 21) }))
    .sort((x, y) => x.r - y.r);
  for (let n = 0; n < LIGHTS_N.full; n++) {
    const y0 = 0.8 + BAND * ((n * 7) % LIGHTS_N.full);
    const pick = order.find(({ p }) => {
      const rr = Math.hypot(p[0], p[2]);
      return p[1] >= y0 - BAND && p[1] < y0 + 2 * BAND && rr > 0.45 && rr < 1.7 &&
        !lights.some((l) => Math.hypot(l.p[0] - p[0], l.p[1] - p[1], l.p[2] - p[2]) < 0.5) &&
        !(o.avoid ?? []).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.45);
    });
    if (!pick) continue;
    const { p, i } = pick;
    lights.push({
      p,
      ph: TAU * rand(i, 22),
      per: 9 + 9 * rand(i, 23),
      tl: LIGHT_LOOP * ((n + rand(i, 24) * 0.8) / LIGHTS_N.full),
      size: 0.55 + 0.45 * rand(i, 25),
    });
  }
  lights.length = Math.min(lights.length, want);

  // each vertex learns of its nearest light, to catch a little of its warmth
  const lt = new Float32Array((pos.length / 3) * 4);
  const REACH = 0.2;
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3] as number;
    const y = pos[v * 3 + 1] as number;
    const z = pos[v * 3 + 2] as number;
    let best = -1;
    let bd = REACH;
    for (let li = 0; li < lights.length; li++) {
      const p = (lights[li] as Light).p;
      const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
      if (d < bd) {
        bd = d;
        best = li;
      }
    }
    if (best >= 0) {
      const L = lights[best] as Light;
      const f = 1 - bd / REACH;
      lt.set([f * f, L.ph, L.per, L.tl], v * 4);
    }
  }

  return {
    pos: new Float32Array(pos),
    a: new Float32Array(A),
    k: new Float32Array(K),
    lt,
    lights,
    tips,
    roots,
    bark,
  };
}
