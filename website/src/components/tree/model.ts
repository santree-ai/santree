/**
 * santree's tree, as numbers: geometry, the ticket clock and the camera, with
 * no three.js in it. The live scene (engine.ts), the prerendered poster
 * (poster.tsx) and the DOM that rides on the scene (stage.tsx) all read this
 * file, so the drawing, the first frame and the panes agree to the pixel.
 *
 * The tree is ONE line. It comes up the taproot (where tickets arrive),
 * spirals out across the floor of the lower tier, winds up a cone to its
 * apex, spirals out again across the gap, winds up the upper cone and ends
 * at the crown, `main`'s newest commit. The envelope of that line is
 * santree's mark, the two stacked triangles of its app icon
 * (M256 128 L173 232 L339 232 Z, M256 248 L148 384 L364 384 Z): the flat
 * spirals are the triangles' bases, the windings their sides.
 *
 * Everything that happens is a bead of light on that line. A ticket (from the
 * app's screenshot fixture, Mallard Labs' QuackStack, src/dev/fixtures/
 * world.ts) rises from its row in the roots and runs along the line to its
 * fork; there it leaves the line as a bough (its worktree), the agent's light
 * goes out along the bough, the tip buds into the PR, and on merge the light
 * runs back onto the line and climbs it to the crown, which brightens.
 *
 * Meters, y up from the ground at the foot of the trunk.
 */

export type V3 = [number, number, number];

/** The app's own colors (src/theme/colors.ts: palette, sessionStateMeta, prStateMeta). */
export const COLOR = {
  ink: "#e9f1ed",
  accent: "#2dd4a7",
  claude: "#d97757",
  codex: "#b9c6dc",
  running: "#3fb950",
  delegating: "#4493f8",
  permission: "#f85149",
  triage: "#4493f8",
  worktree: "#a78bfa",
  open: "#848d97",
  merged: "#a371f7",
} as const;

const deg = (d: number) => (d * Math.PI) / 180;
const TAU = Math.PI * 2;

// ——— the mark, as two cones ———

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
/** Where the taproot starts, under the ledger's last row. */
export const ROOT_Y = -0.95;

const coneR = (c: Cone, y: number) => (c.r * (c.apex - y)) / (c.apex - c.base);

// ——— the line ———

/** Turns per stretch: enough to read as a cone, few enough to read as one line. */
const TURNS = { floor: 2.2, lower: 8, gap: 1.6, upper: 6 } as const;

export type Part = "root" | "floor" | "lower" | "gap" | "upper" | "crown";

export interface Line {
  pts: V3[];
  /** Arc length at each point, 0..1. */
  sig: number[];
  part: Part[];
  /** The winding angle at each point (rad). */
  ang: number[];
  length: number;
}

function buildLine(): Line {
  const pts: V3[] = [];
  const part: Part[] = [];
  const ang: number[] = [];
  let a = deg(-90);
  const at = (r: number, y: number, p: Part) => {
    pts.push([r * Math.cos(a), y, -r * Math.sin(a)]);
    part.push(p);
    ang.push(a);
  };
  // the taproot, straight up to the floor of the lower tier
  for (let i = 0; i < 40; i++) at(0, ROOT_Y + ((LOWER.base - ROOT_Y) * i) / 40, "root");
  // out across the floor, an Archimedean spiral (equal spacing reads as a disc)
  const nF = 520;
  for (let i = 0; i < nF; i++) {
    const k = i / nF;
    at(LOWER.r * k, LOWER.base, "floor");
    a += (TAU * TURNS.floor) / nF;
  }
  // up the lower cone: the same angular speed per height keeps the pitch even
  const nL = 2600;
  for (let i = 0; i < nL; i++) {
    const y = LOWER.base + ((LOWER.apex - LOWER.base) * i) / nL;
    at(coneR(LOWER, y), y, "lower");
    a += (TAU * TURNS.lower) / nL;
  }
  // across the gap: out from the lower apex to the upper tier's rim, rising a little
  const nG = 420;
  for (let i = 0; i < nG; i++) {
    const k = i / nG;
    at(UPPER.r * k, LOWER.apex + (UPPER.base - LOWER.apex) * k, "gap");
    a += (TAU * TURNS.gap) / nG;
  }
  const nU = 1900;
  for (let i = 0; i <= nU; i++) {
    const y = UPPER.base + ((UPPER.apex - UPPER.base) * i) / nU;
    at(coneR(UPPER, y), y, "upper");
    if (i < nU) a += (TAU * TURNS.upper) / nU;
  }
  for (let i = 1; i <= 12; i++) at(0, UPPER.apex + ((CROWN[1] - UPPER.apex) * i) / 12, "crown");

  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[i - 1]!;
    cum.push(cum[i - 1]! + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
  }
  const length = cum[cum.length - 1]!;
  return { pts, sig: cum.map((c) => c / length), part, ang, length };
}

export const LINE: Line = buildLine();

/** The point at arc length sigma (0..1) along the line. */
export function lineAt(sigma: number): V3 {
  const { sig, pts } = LINE;
  const s = Math.min(1, Math.max(0, sigma));
  let lo = 0;
  let hi = sig.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sig[mid]! < s) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const k = (s - sig[lo]!) / Math.max(1e-9, sig[hi]! - sig[lo]!);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** The index on a winding stretch closest to height y. */
function indexAt(p: Part, y: number) {
  let best = -1;
  let d = Number.POSITIVE_INFINITY;
  LINE.pts.forEach((q, i) => {
    if (LINE.part[i] !== p) return;
    const e = Math.abs(q[1] - y);
    if (e < d) {
      d = e;
      best = i;
    }
  });
  return best;
}

/** The ledger's rows hang off the taproot here, top to bottom. */
export const rowPoint = (row: number): V3 => [0, -0.2 - row * 0.115, 0];
export const rowSigma = (row: number) => {
  const y = rowPoint(row)[1];
  const i = Math.round(((y - ROOT_Y) / (LOWER.base - ROOT_Y)) * 40);
  return LINE.sig[Math.max(0, Math.min(39, i))]!;
};

/** Deterministic noise, so the server and every client grow the same tree. */
export function rand(i: number, salt = 0) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ——— a bough: where a ticket leaves the line ———

export interface Limb {
  /** The fork on the line, its arc length, and the bough's bearing (outward). */
  fork: V3;
  sigma: number;
  phi: number;
  /** How far out it reaches, and how far its tip droops below the fork. */
  len: number;
  droop: number;
}

function limbAt(p: Part, y: number): Limb {
  const i = indexAt(p, y);
  const fork = LINE.pts[i]!;
  const r = Math.hypot(fork[0], fork[2]);
  return {
    fork,
    sigma: LINE.sig[i]!,
    phi: LINE.ang[i]!,
    len: 0.62 + 0.28 * r,
    droop: 0.16 + 0.08 * r,
  };
}

/** Out from the fork: level at first, then the droop of a fir, curling a little with the winding. */
export function boughAt(b: Limb, s: number): V3 {
  const curl = 0.22 * s * s;
  const ph = b.phi + curl;
  const rho = b.len * s;
  const y = b.fork[1] + 0.05 * Math.sin(Math.PI * s) * (1 - s) - b.droop * s * s;
  return [b.fork[0] + rho * Math.cos(ph), y, b.fork[2] - rho * Math.sin(ph)];
}

// ——— tickets ———

export type Agent = "claude" | "codex";

export interface Ticket {
  id: string;
  title: string;
  agent: Agent;
  /** What the agent's dot says while it works. */
  work: "running" | "delegating" | "permission";
  ask?: string;
  diff?: string;
  pr?: number;
}

export interface Bough extends Ticket, Limb {
  /** Seconds into its loop when the page opens (the poster's moment). */
  offset: number;
  /** Its row in the roots' ledger, top to bottom. */
  row: number;
}

const ticketBough = (t: Ticket, p: Part, y: number, offset: number, row: number): Bough => ({
  ...t,
  ...limbAt(p, y),
  offset,
  row,
});

/** The ticket the scroll follows from triage to main: the one whose agent stops to ask. */
export const FEATURED: Bough = ticketBough(
  {
    id: "QK-138",
    title: "Migrate quack events to the pond_v2 schema",
    agent: "claude",
    work: "permission",
    ask: "Allow Bash(pnpm db:migrate --dry-run)?",
    diff: "+412 −88",
    pr: 418,
  },
  "lower",
  1.38,
  7.2,
  1,
);

/** The others, on the wall clock, spread through the loop: two or three lit at once. */
export const AMBIENT: Bough[] = [
  ticketBough(
    {
      id: "QK-142",
      title: "Ducks render upside down in Safari",
      agent: "claude",
      work: "running",
      diff: "+54 −1",
      pr: 421,
    },
    "lower",
    0.78,
    5.6,
    0,
  ),
  ticketBough(
    {
      id: "QK-127",
      title: "Pond dashboard: dark mode",
      agent: "codex",
      work: "delegating",
      diff: "+188 −40",
      pr: 409,
    },
    "lower",
    1.95,
    12.4,
    2,
  ),
  ticketBough(
    {
      id: "QK-119",
      title: "Rate-limit the bread dispenser API",
      agent: "claude",
      work: "running",
      diff: "+156 −12",
      pr: 412,
    },
    "upper",
    3.2,
    16.4,
    3,
  ),
];

export const ALL: Bough[] = [FEATURED, ...AMBIENT];

/** The ledger: the tickets on the tree, and two still waiting in the backlog. */
export const LEDGER_ROWS: { id: string; title: string; row: number; bough?: Bough }[] = [
  ...ALL.map((b) => ({ id: b.id, title: b.title, row: b.row, bough: b })),
  { id: "QK-146", title: "Feather cache never evicts", row: 4 },
  { id: "QK-147", title: "Realtime pond updates over WebSockets", row: 5 },
].sort((a, b) => a.row - b.row);

// ——— the clock ———

/** One ticket's whole life, in seconds. */
export const LOOP = 24;
export const PHASE = {
  travel: [0, 2.6],
  sprout: [2.6, 3.8],
  work: [3.8, 10.8],
  pr: [10.8, 13.0],
  merged: [13.0, 13.7],
  back: [13.7, 17.6],
} as const satisfies Record<string, readonly [number, number]>;
/** The share of the run back spent on the bough; the rest is the climb up the line. */
const BACK_SPLIT = 0.16;
/** The permission prompt holds the agent this long, partway out. */
export const ASK = { at: 0.55, from: 5.6, to: 8.4 } as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = (x: number) => x * x * (3 - 2 * x);
/** Quintic ease-in-out, for the long runs along the line. */
export const glide = (x: number) => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2);
const span = (u: number, [a, b]: readonly [number, number]) => clamp01((u - a) / (b - a));

export type Stage = "rest" | "travel" | "sprout" | "work" | "pr" | "merged" | "back";
export type Dot =
  | "todo"
  | "triage"
  | "worktree"
  | "running"
  | "delegating"
  | "permission"
  | "open"
  | "merged";

export interface BoughState {
  stage: Stage;
  /** Arc length of the incoming bead (triage), while it runs to the fork. */
  bead: number;
  /** 0..1: the bough drawn out from the fork. */
  grow: number;
  /** How lit the bough is (0 = gone). */
  lit: number;
  /** 0..1: the agent's way out along the bough. */
  progress: number;
  /** 0..1: the PR's bud at the tip. */
  bloom: number;
  /** The merge light: on the bough (s, 1 → 0) or on the line (arc length), or null. */
  back: { s: number } | { sigma: number } | null;
  /** The crown's flash, after this merge reaches it. */
  flash: number;
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
    if (b.work === "permission") {
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
        : { sigma: b.sigma + (1 - b.sigma) * glide((k - BACK_SPLIT) / (1 - BACK_SPLIT)) };
  const dot: Dot =
    stage === "travel"
      ? "triage"
      : stage === "sprout"
        ? "worktree"
        : stage === "work"
          ? asking
            ? "permission"
            : b.work === "delegating"
              ? "delegating"
              : "running"
          : stage === "pr"
            ? "open"
            : stage === "merged" || stage === "back"
              ? "merged"
              : "todo";
  const grow = stage === "rest" || stage === "travel" ? 0 : ease(span(u, PHASE.sprout));
  const r0 = rowSigma(b.row);
  return {
    stage,
    bead: stage === "travel" ? r0 + (b.sigma - r0) * glide(span(u, PHASE.travel)) : -1,
    grow,
    lit: stage === "back" ? 1 - ease(clamp01(k / (BACK_SPLIT * 1.6))) : grow,
    progress: stage === "rest" ? 0 : progress,
    bloom:
      stage === "pr" || stage === "merged"
        ? ease(span(u, [PHASE.pr[0], PHASE.pr[0] + 0.7]))
        : stage === "back"
          ? 1 - ease(clamp01(k / BACK_SPLIT))
          : 0,
    back,
    flash: u >= PHASE.back[1] ? Math.exp(-(u - PHASE.back[1]) * 1.2) : 0,
    dot,
    asking,
  };
}

/** Where the merge light is, in the world. */
export function backPoint(b: Bough, back: NonNullable<BoughState["back"]>): V3 {
  return "s" in back ? boughAt(b, back.s) : lineAt(back.sigma);
}

export const DOT_COLOR: Record<Dot, string> = {
  todo: "#6e7681",
  triage: COLOR.triage,
  worktree: COLOR.worktree,
  running: COLOR.running,
  delegating: COLOR.delegating,
  permission: COLOR.permission,
  open: COLOR.open,
  merged: COLOR.merged,
};

export const DOT_WORD: Record<Dot, string> = {
  todo: "todo",
  triage: "triage",
  worktree: "worktree",
  running: "running",
  delegating: "delegating",
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

export function keys(wide: boolean, heroWide = wide): Key[] {
  const F = FEATURED;
  const kx = wide ? -0.6 : 0;
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
  [1.0, 1.0],
  [1.4, 1.6],
  [2.15, 3.2],
  [2.55, 3.9],
  [3.3, 5.8],
  [3.75, 8.2],
  [4.45, 11.4],
  [4.85, 13.0],
  [5.6, 15.4],
  [6.0, 17.4],
  [6.7, 18.4],
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
