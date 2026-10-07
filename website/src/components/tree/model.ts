/**
 * santree's tree, as numbers: the clock the tickets live by and the camera,
 * with no three.js in it. The grown tree itself (grow.ts) is a conifer from a
 * seed. The live scene (engine.ts), the prerendered poster (poster.tsx) and the
 * DOM that rides on the scene (stage.tsx) all read these two files, so the
 * drawing, the first frame and the panes agree to the pixel.
 *
 * Everything that happens is a quiet light on the tree. A ticket rises up the
 * trunk as a front of light to its fork (a plain height, so it reads as a
 * tide); there it leaves for a branch (its worktree), the agent's point of
 * light goes out along the branch, the tip buds into the PR, and on merge a
 * second front climbs the trunk to the crown, which brightens, and the branch
 * keeps a settled light. The tickets are invented (the app's screenshot
 * fixture) and are never named on the page: no tracker, code host or agent is
 * either. The other lights on the tree breathe on their own slow clocks
 * (grow.ts); work landing on one swells it for a while and lets it settle.
 *
 * One ticket's life is 41 s inside a 96 s loop, so at most two things move at
 * once, and "needs you" is a steady warm hold, never a pulse.
 *
 * Meters, y up from the ground at the foot of the trunk.
 */
import { boughAt, CONES, CROWN, type Limb, limbNear, rand, TOP, trunkAt, type V3 } from "./grow";

export type { Limb, V3 };
export { boughAt, CONES, CROWN, rand, TOP };

/** The app's own colors (src/theme/colors.ts: palette, sessionStateMeta, prStateMeta). */
export const COLOR = {
  ink: "#e9f1ed",
  /** The one accent: the mark's emerald. */
  accent: "#2dd4a7",
  /** An agent at work: one neutral light, whichever agent it is. */
  agent: "#dfe8e4",
  /** Needs you: a warm hold, never a flare. */
  ask: "#d9a55f",
  open: "#8f989d",
  /** The resting lights on the branches: tickets, in the warm of a window at dusk. */
  light: "#f2d3a0",
} as const;

const deg = (d: number) => (d * Math.PI) / 180;
const TAU = Math.PI * 2;

/** The ledger's rows hang off the taproot here, top to bottom. */
export const rowPoint = (row: number): V3 => trunkAt(-0.2 - row * 0.115);

// ——— tickets ———

export interface Ticket {
  id: string;
  title: string;
  /** Does its agent stop to ask partway out? */
  asks?: boolean;
}

export interface Bough extends Ticket, Limb {
  /** Seconds into its loop when the page opens (the poster's moment). */
  offset: number;
  /** Where its light enters the line, down the taproot. */
  row: number;
}

/** A ticket's bough is one of the tree's real branches: the one nearest a height and a bearing. */
const ticketBough = (t: Ticket, y: number, phi: number, offset: number, row: number): Bough => ({
  ...t,
  ...limbNear(y, phi),
  offset,
  row,
});

/** The ticket the scroll follows from triage to main: the one whose agent stops to ask. */
export const FEATURED: Bough = ticketBough(
  { id: "featured", title: "", asks: true },
  1.38,
  deg(-34),
  19,
  1,
);

/** The others, on the wall clock, far apart in the loop: one or two things happen at once. */
export const AMBIENT: Bough[] = [
  ticketBough({ id: "a", title: "" }, 0.95, deg(-148), 27, 0),
  ticketBough({ id: "b", title: "" }, 1.95, deg(-92), 60, 2),
  ticketBough({ id: "c", title: "" }, 3.2, deg(-18), 70, 3),
];

export const ALL: Bough[] = [FEATURED, ...AMBIENT];

// ——— the clock ———

/** One ticket's whole life, in seconds: long, slow, and mostly rest. */
export const LOOP = 96;
export const PHASE = {
  travel: [0, 10],
  sprout: [10, 12.5],
  work: [12.5, 25],
  pr: [25, 30],
  merged: [30, 31.5],
  back: [31.5, 41],
} as const satisfies Record<string, readonly [number, number]>;
/** The share of the run back spent on the bough; the rest is the climb up the line. */
const BACK_SPLIT = 0.16;
/** The permission prompt holds the agent this long, partway out. */
export const ASK = { at: 0.55, from: 17, to: 22 } as const;

/** The crown's answer to a merge: it swells over a second and a half and settles over many. */
const crownFlash = (k: number) => ease(clamp01(k / 1.6)) * Math.exp(-Math.max(0, k - 1.6) * 0.35);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = (x: number) => x * x * (3 - 2 * x);
/** Quintic ease-in-out, for the long runs along the line. */
export const glide = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2);
const span = (u: number, [a, b]: readonly [number, number]) => clamp01((u - a) / (b - a));

export type Stage = "rest" | "travel" | "sprout" | "work" | "pr" | "merged" | "back";
export type Dot = "triage" | "worktree" | "running" | "permission" | "open" | "merged";

export interface BoughState {
  stage: Stage;
  /** Height of the front of light rising to the fork (triage), or -99. */
  bead: number;
  /** 0..1: the bough drawn out from the fork. */
  grow: number;
  /** How lit the bough is (0 = gone). */
  lit: number;
  /** 0..1: the agent's way out along the bough. */
  progress: number;
  /** 0..1: the PR's bud at the tip. */
  bloom: number;
  /** The merge light: on the bough (s, 1 → 0) or the rising front on the line (height), or null. */
  back: { s: number } | { y: number } | null;
  /** The crown's flash, after this merge reaches it. */
  flash: number;
  /** After a merge, the light left on its branch: it swells, then settles over many seconds. */
  settled: number;
  dot: Dot;
  asking: boolean;
}

/** A ticket's place in its life, u seconds into the loop. */
export function stateAt(b: Bough, u0: number): BoughState {
  const u = ((u0 % LOOP) + LOOP) % LOOP;
  const stage: Stage =
    u < PHASE.travel[1]
      ? "travel"
      : u < PHASE.sprout[1]
        ? "sprout"
        : u < PHASE.work[1]
          ? "work"
          : u < PHASE.pr[1]
            ? "pr"
            : u < PHASE.merged[1]
              ? "merged"
              : u < PHASE.back[1]
                ? "back"
                : "rest";

  let progress = 0;
  let asking = false;
  if (u >= PHASE.work[0]) {
    if (b.asks) {
      const [w0, w1] = PHASE.work;
      if (u < ASK.from) progress = ASK.at * ease(span(u, [w0, ASK.from]));
      else if (u < ASK.to) {
        progress = ASK.at;
        asking = true;
      } else progress = ASK.at + (1 - ASK.at) * ease(span(u, [ASK.to, w1]));
    } else progress = ease(span(u, PHASE.work));
  }
  const k = span(u, PHASE.back);
  const back =
    stage !== "back"
      ? null
      : k < BACK_SPLIT
        ? { s: 1 - ease(k / BACK_SPLIT) }
        : { y: b.fork[1] + (CROWN[1] - b.fork[1]) * ease((k - BACK_SPLIT) / (1 - BACK_SPLIT)) };
  const dot: Dot =
    stage === "travel"
      ? "triage"
      : stage === "sprout"
        ? "worktree"
        : stage === "work"
          ? asking
            ? "permission"
            : "running"
          : stage === "pr"
            ? "open"
            : "merged";
  const grow = stage === "rest" || stage === "travel" ? 0 : ease(span(u, PHASE.sprout));
  const y0 = rowPoint(b.row)[1];
  return {
    stage,
    bead: stage === "travel" ? y0 + (b.fork[1] - y0) * ease(span(u, PHASE.travel)) : -99,
    grow,
    lit: stage === "back" ? 1 - ease(clamp01(k / (BACK_SPLIT * 1.6))) : grow,
    progress: stage === "rest" ? 0 : progress,
    bloom:
      stage === "pr" || stage === "merged"
        ? ease(span(u, [PHASE.pr[0], PHASE.pr[0] + 2]))
        : stage === "back"
          ? 1 - ease(clamp01(k / BACK_SPLIT))
          : 0,
    back,
    flash: u >= PHASE.back[1] ? crownFlash(u - PHASE.back[1]) : 0,
    settled:
      u >= PHASE.back[1] ? ease(clamp01((u - PHASE.back[1]) / 4)) * Math.exp(-Math.max(0, u - PHASE.back[1] - 4) / 20) : 0,
    dot,
    asking,
  };
}

/** Where the merge light is, in the world. */
export function backPoint(b: Bough, back: NonNullable<BoughState["back"]>): V3 {
  return "s" in back ? boughAt(b, back.s) : b.fork;
}

export const DOT_COLOR: Record<Dot, string> = {
  triage: COLOR.open,
  worktree: COLOR.open,
  running: COLOR.agent,
  permission: COLOR.ask,
  open: COLOR.open,
  merged: COLOR.accent,
};

export const DOT_WORD: Record<Dot, string> = {
  triage: "triage",
  worktree: "worktree",
  running: "running",
  permission: "needs you",
  open: "in review",
  merged: "merged",
};

// ——— the camera ———

export interface Pose {
  target: V3;
  dist: number;
  /** Bearing of the camera around the target (rad, 0 = +z). */
  az: number;
  /** Elevation above the target (rad). */
  el: number;
  /** Vertical field of view (deg). */
  fov: number;
  /** Where the target sits on screen, in half-heights from the centre (+x right, +y up). */
  kx: number;
  ky: number;
}

export const HERO_AZ0 = deg(-18);
/** The hero's slow turn, rad per second. */
export const TURN = TAU / 160;

export interface Key {
  /** Scroll position, in viewport heights from the top of the sequence. */
  s: number;
  pose: Pose;
}

/** Desktop: the hero, then five stations along QK-138's life, then the mark. */
export const STATIONS_S = [1.0, 2.15, 3.3, 4.45, 5.6] as const;
export const END_S = 6.7;

export function heroPose(wide: boolean): Pose {
  return wide
    ? { target: [0, 1.95, 0], dist: 12.6, az: HERO_AZ0, el: deg(7), fov: 28, kx: 0.64, ky: -0.05 }
    : { target: [0, 2.2, 0], dist: 26, az: HERO_AZ0, el: deg(7), fov: 28, kx: 0, ky: 0.6 };
}

/** The camera sees bough b side-on, growing to the left of the screen, turned by `turn` toward the reader. */
const sideOn = (b: Limb, turn: number) => b.phi + Math.PI - deg(turn);

export function keys(wide: boolean, heroWide = wide, aspect = 1.6): Key[] {
  const F = FEATURED;
  // The pane takes the right ~48% of the width; the tree is centred in what is left.
  const kx = wide ? -Math.min(0.95, Math.max(0.5, 0.48 * aspect)) : 0;
  const ky = 0.12;
  const far = wide ? 1 : 1.35;
  const list: Key[] = [
    { s: 0, pose: heroPose(heroWide) },
    // Triage: down at the roots, where the ledger hangs off the taproot.
    {
      s: STATIONS_S[0],
      pose: {
        target: [0, -0.15, 0],
        dist: 5.4 * far,
        az: sideOn(F, 30),
        el: deg(15),
        fov: 30,
        kx,
        ky: wide ? 0.22 : ky,
      },
    },
    // Branch: at the fork, the bead leaving the line.
    {
      s: STATIONS_S[1],
      pose: {
        target: boughAt(F, 0.12),
        dist: 4.4 * far,
        az: sideOn(F, 34),
        el: deg(13),
        fov: 30,
        kx,
        ky,
      },
    },
    // Steer: beside the agent, partway out, where it stops to ask.
    {
      s: STATIONS_S[2],
      pose: {
        target: boughAt(F, ASK.at),
        dist: 3.7 * far,
        az: sideOn(F, 52),
        el: deg(15),
        fov: 30,
        kx,
        ky,
      },
    },
    // Review: at the tip, where the PR buds.
    {
      s: STATIONS_S[3],
      pose: {
        target: boughAt(F, 1),
        dist: 3.7 * far,
        az: sideOn(F, 72),
        el: deg(9),
        fov: 30,
        kx,
        ky,
      },
    },
    // Ship: up the line to the crown.
    {
      s: STATIONS_S[4],
      pose: {
        target: [0, TOP - 0.5, 0],
        dist: 5.6 * far,
        az: sideOn(F, -20),
        el: deg(4),
        fov: 30,
        kx,
        ky,
      },
    },
    // The whole tree, square on, and the mark resolves out of it.
    {
      s: END_S,
      pose: {
        target: [0, 2.05, 0],
        dist: 12.8 * far,
        az: sideOn(F, -60),
        el: 0,
        fov: 28,
        kx: 0,
        ky: 0.04,
      },
    },
  ];
  // The camera only ever climbs one way round the tree: each bearing is
  // carried past the last, so scrolling reads as a climb, not a wobble.
  for (let i = 2; i < list.length; i++) {
    const prev = list[i - 1]!.pose.az;
    let az = list[i]!.pose.az;
    while (az < prev + deg(10)) az += TAU;
    while (az > prev + deg(190)) az -= TAU;
    list[i]!.pose.az = az;
  }
  return list;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function mixPose(a: Pose, b: Pose, t: number, shortest: boolean): Pose {
  return {
    target: [
      lerp(a.target[0], b.target[0], t),
      lerp(a.target[1], b.target[1], t),
      lerp(a.target[2], b.target[2], t),
    ],
    dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), t)),
    az: shortest ? a.az + wrap(b.az - a.az) * t : lerp(a.az, b.az, t),
    el: lerp(a.el, b.el, t),
    fov: lerp(a.fov, b.fov, t),
    kx: lerp(a.kx, b.kx, t),
    ky: lerp(a.ky, b.ky, t),
  };
}

/** The share of each leg the camera spends resting at the station it left. */
export const HOLD = 0.34;

/** The camera at scroll position s (viewport heights) and wall time t (s since the page opened). */
export function poseAt(ks: Key[], s: number, t: number, still: boolean): Pose {
  const first = ks[0]!;
  const hero = { ...first.pose, az: first.pose.az + (still ? 0 : TURN * t) };
  if (s <= 0) return hero;
  const list = [{ ...first, pose: hero }, ...ks.slice(1)];
  let i = 0;
  while (i < list.length - 2 && s > list[i + 1]!.s) i++;
  const a = list[i]!;
  const b = list[i + 1]!;
  const x = clamp01((s - a.s) / (b.s - a.s));
  const hold = i === 0 ? 0 : HOLD;
  const e = ease(ease(clamp01((x - hold) / (1 - hold))));
  const p = mixPose(a.pose, b.pose, e, i === 0);
  // A breath of drift at rest, gone by the time the mark resolves.
  if (!still) p.az += 0.02 * Math.sin(t * 0.21) * (1 - clamp01((s - END_S + 0.8) / 0.8));
  return p;
}

/**
 * QK-138's place in its life. In the hero it runs on the wall clock like the
 * others; once the reader scrolls, the scroll owns it: it fades out over the
 * first stretch and comes back in at the roots.
 */
const U_MAP: [number, number][] = [
  [0.4, 0.0],
  [1.0, 0.8],
  [1.4, 3.5],
  [2.15, 11.5],
  [2.55, 13.5],
  [3.3, 19],
  [3.75, 23],
  [4.45, 27.5],
  [4.85, 31],
  [5.6, 36],
  [6.0, 39.5],
  [6.7, 41],
];
export function featuredAt(s: number, t: number): { u: number; alpha: number } {
  if (s < 0.3) return { u: t + FEATURED.offset, alpha: 1 - clamp01(s / 0.3) };
  if (s < U_MAP[0]![0]) return { u: LOOP - 0.01, alpha: 1 };
  for (let i = 1; i < U_MAP.length; i++) {
    const [s1, u1] = U_MAP[i]!;
    const [s0, u0] = U_MAP[i - 1]!;
    if (s <= s1) return { u: u0 + ((s - s0) / (s1 - s0)) * (u1 - u0), alpha: 1 };
  }
  return { u: U_MAP[U_MAP.length - 1]![1], alpha: 1 };
}

/** How far the mark has resolved out of the line, at scroll s. */
export const markAt = (s: number) => ease(clamp01((s - (END_S - 0.75)) / 0.7));

/** The mark's two triangles, in the plane through main square to the camera: [half-width, y] corners. */
export const MARK: [number, number][][] = CONES.map((c) => [
  [0, c.apex],
  [c.r, c.base],
  [-c.r, c.base],
]);

// ——— projection, the same matrices three.js builds ———

export interface View {
  eye: V3;
  r: V3;
  u: V3;
  b: V3;
  f: number;
  aspect: number;
  /** Lens shift in NDC, as written into projectionMatrix[8] and [9]. */
  sx: number;
  sy: number;
}

function norm(v: V3): V3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function eyeOf(p: Pose): V3 {
  const c = Math.cos(p.el);
  return [
    p.target[0] + p.dist * c * Math.sin(p.az),
    p.target[1] + p.dist * Math.sin(p.el),
    p.target[2] + p.dist * c * Math.cos(p.az),
  ];
}

export function viewOf(p: Pose, aspect: number): View {
  const eye = eyeOf(p);
  const b = norm(sub(eye, p.target));
  const r = norm(cross([0, 1, 0], b));
  const u = cross(b, r);
  return {
    eye,
    r,
    u,
    b,
    f: 1 / Math.tan((p.fov * Math.PI) / 360),
    aspect,
    sx: -p.kx / aspect,
    sy: -p.ky,
  };
}

/** A world point to NDC (x right, y up, -1..1) and its view depth. */
export function project(v: View, p: V3): { x: number; y: number; depth: number } {
  const d = sub(p, v.eye);
  const xv = dot(d, v.r);
  const yv = dot(d, v.u);
  const zv = dot(d, v.b);
  const w = -zv;
  return { x: ((v.f / v.aspect) * xv) / w - v.sx, y: (v.f * yv) / w - v.sy, depth: w };
}
