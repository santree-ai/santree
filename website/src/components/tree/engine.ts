/**
 * The live tree. Its own chunk: three/webgpu and the TSL graph load only when
 * the stage asks for them, after the poster has painted.
 *
 * WebGPURenderer runs on WebGPU where the browser has it and on three's
 * WebGL2 backend where it does not; every material is a TSL node material,
 * so one graph compiles to WGSL or GLSL. Materials are built once and driven
 * by uniforms (a graph rebuilt at runtime recompiles its shaders).
 *
 * What it draws is grow.ts and model.ts: a conifer of additive hairlines (a
 * trunk, whorls of sagging boughs, fronds of twigs and needles), swaying a
 * hand's width in a wind that is a function of position and time alone, so
 * every light and label on the page moves with it; a front of light that rises
 * the trunk to a ticket's fork; the lit boughs where tickets leave it; the
 * resting lights, each on its own slow breath; a few drifting embers; the
 * crown; and, at the end of the scroll, the mark resolving out of the tree.
 *
 * Restraint is the look. Strokes are hairlines, the far side and whatever is
 * out of focus thin out, lights are soft points with a faint halo, there is
 * no bloom, and nothing blinks: every motion has a period of many seconds.
 */
import {
  attribute,
  cameraViewMatrix,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  mix,
  pass,
  positionLocal,
  positionView,
  screenUV,
  sin,
  smoothstep,
  step,
  color as tslColor,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import {
  GROUND,
  grow,
  LIGHT_LOOP,
  ROOT_Y,
  swayP,
  TAU,
  trunkAt,
} from "./grow";
import {
  ALL,
  type Bough,
  backPoint,
  boughAt,
  COLOR,

  CROWN,
  FEATURED,

  MARK,
  type Pose,
  rand,
  rowPoint,
  stateAt,
  TOP,
  type V3,
  viewOf,
} from "./model";

export interface Frame {
  pose: Pose;
  /** Wall time, seconds since the page opened. */
  t: number;
  /** The followed ticket's place in its life (seconds into its loop), and how present it is. */
  featured: { u: number; alpha: number };
  /** 0 in the hero, 1 at a station: the other tickets step back. */
  focus: number;
  /** 0..1: the mark resolving out of the line. */
  mark: number;
}

export interface Engine {
  backend: "webgpu" | "webgl2";
  render(f: Frame): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

// biome-ignore lint/suspicious/noExplicitAny: TSL's node generics do not survive composition.
type N = any;

const cnode = (hex: string): N => (tslColor as N)(new THREE.Color(hex));

/**
 * A tube along a polyline at UNIT radius: `ctr` carries the centre of each
 * ring, so the vertex stage can set the real width from the ring's depth.
 * Each ring also carries the attributes in `attrs`.
 */
function tube(pts: V3[], attrs: Record<string, number[]>, sides = 4) {
  const pos: number[] = [];
  const ctr: number[] = [];
  const index: number[] = [];
  const out: Record<string, number[]> = Object.fromEntries(Object.keys(attrs).map((k) => [k, []]));
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)] as V3;
    const b = pts[Math.min(pts.length - 1, i + 1)] as V3;
    t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    n1.crossVectors(t, Math.abs(t.y) > 0.95 ? side : up).normalize();
    n2.crossVectors(t, n1).normalize();
    const p = pts[i] as V3;
    for (let j = 0; j < sides; j++) {
      const ang = ((j + 0.5) / sides) * Math.PI * 2;
      const c = Math.cos(ang);
      const d = Math.sin(ang);
      pos.push(p[0] + n1.x * c + n2.x * d, p[1] + n1.y * c + n2.y * d, p[2] + n1.z * c + n2.z * d);
      ctr.push(p[0], p[1], p[2]);
      for (const k of Object.keys(attrs))
        (out[k] as number[]).push((attrs[k] as number[])[i] as number);
      if (i < pts.length - 1) {
        const q = i * sides;
        const j1 = (j + 1) % sides;
        index.push(q + j, q + sides + j, q + j1, q + j1, q + sides + j, q + sides + j1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("ctr", new THREE.Float32BufferAttribute(ctr, 3));
  for (const k of Object.keys(out))
    g.setAttribute(k, new THREE.Float32BufferAttribute(out[k] as number[], 1));
  g.setIndex(index);
  return g;
}

export async function createEngine(
  canvas: HTMLCanvasElement,
  opts: { lite: boolean },
): Promise<Engine> {
  const make = async (forceWebGL: boolean) => {
    const r = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: false, forceWebGL });
    await r.init();
    return r;
  };
  let renderer: THREE.WebGPURenderer;
  try {
    renderer = await make(false);
  } catch {
    renderer = await make(true);
  }
  const backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
    ? "webgpu"
    : "webgl2";
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lite ? 1.5 : 2));
  renderer.setClearColor(0x060708, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 80);

  const camDist = uniform(12);
  /** tan(fov/2) / viewport height in CSS px: a ring of depth d is one px wide at d * pxU * 2. */
  const pxU = uniform(0.0003);
  const dimU = uniform(1);
  const markU = uniform(0);
  const focusU = uniform(0);
  /** The one clock: wall seconds since the page opened. Scroll never touches it. */
  const clockU = uniform(0);
  const inkC = cnode(COLOR.ink);

  /** The wind, mirrored from grow.ts's sway(). */
  const swayN = (p: N): N => {
    const r: N = vec2(p.x, p.z).length();
    const k: N = r.mul(0.03).mul(p.y.max(0).div(TOP).mul(0.5).add(0.5));
    const t: N = clockU;
    return vec3(
      k.mul(sin(t.mul(0.5).add(p.y.mul(0.9)).add(p.z.mul(0.7)))),
      k.mul(0.3).mul(sin(t.mul(0.5).add(p.y.mul(0.9)).add(p.z.mul(0.7)).add(1.2))),
      k.mul(0.7).mul(sin(t.mul(0.42).add(p.y.mul(0.8)).add(p.x.mul(1.1)).add(1.7))),
    );
  };

  /** The far side drops back; whatever brushes the lens fades out. */
  const depth: N = positionView.z.negate();
  const far: N = mix(float(0.3), float(1), smoothstep(camDist.add(1.7), camDist.sub(1.1), depth));
  const nearFade: N = smoothstep(float(0.35), float(1.3), depth);

  /** Vertex stage of a hairline: unit tube scaled to `px` CSS pixels, a touch thinner when far. */
  function hairline(px: number): N {
    const c: N = attribute("ctr", "vec3");
    const d: N = cameraViewMatrix.mul(vec4(c, 1)).z.negate();
    const near: N = smoothstep(camDist.add(1.8), camDist.sub(1.2), d);
    const w: N = mix(float(0.62), float(1.12), near).mul(px);
    return c.add(swayN(c)).add(positionLocal.sub(c).mul(d.mul(pxU).mul(w)));
  }

  type Shape = "soft" | "ring" | "core";
  function spriteMat(shape: Shape, tint: N, alpha: N) {
    const m = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const d: N = uv().sub(0.5).length().mul(2);
    const body: N =
      shape === "soft"
        ? exp(d.mul(d).mul(-6)).sub(0.004).max(0)
        : shape === "ring"
          ? smoothstep(float(0.8), float(0.88), d).mul(
              float(1).sub(smoothstep(float(0.93), float(1.0), d)),
            )
          : float(1).sub(smoothstep(float(0.62), float(0.9), d));
    m.colorNode = tint;
    m.opacityNode = body.mul(alpha).mul(nearFade);
    return m;
  }
  const add = <T extends THREE.Object3D>(o: T, order = 0) => {
    o.renderOrder = order;
    scene.add(o);
    return o;
  };

  // ——— the tree: foliage as hairlines, additive, thinning with depth and distance from focus ———
  const grown = grow({
    lite: opts.lite,
    thin: opts.lite ? 2 : 1,
    avoid: ALL.flatMap((b) => [boughAt(b, 1), boughAt(b, 0.6)]),
  });
  const LN = grown.lights.length;

  /** How lit light (ph, per, tl) is, mirrored from grow.ts's lightLevel. */
  const lightLevelN = (ph: N, per: N, tl: N): N => {
    const x: N = sin(clockU.mul(TAU).div(per).add(ph)).mul(0.5).add(0.5);
    const e: N = x.mul(x).mul(float(3).sub(x.mul(2)));
    const u: N = clockU.sub(tl).add(LIGHT_LOOP).mod(LIGHT_LOOP);
    const bump: N = smoothstep(float(0), float(5), u).mul(exp(u.sub(5).max(0).div(-25)));
    return e.mul(0.3).add(0.58).add(bump.mul(0.9));
  };

  /** View depth of a world point (for sizes set in the vertex stage, where positionView is not yet known). */
  const viewDepth = (p: N): N => cameraViewMatrix.mul(vec4(p, 1)).z.negate();

  /** Defocus: far from the plane the camera rests on, a line spreads thin. */
  const dof: N = float(1).div(
    float(1).add(depth.sub(camDist).div(camDist).pow(2).mul(opts.lite ? 24 : 40)),
  );
  const woodC = cnode("#aebdb6");
  const needleC = cnode("#7fb9a2");
  const warmC = cnode(COLOR.light);

  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute("position", new THREE.BufferAttribute(grown.pos, 3));
  leaves.setAttribute("a", new THREE.BufferAttribute(grown.a, 1));
  leaves.setAttribute("k", new THREE.BufferAttribute(grown.k, 1));
  leaves.setAttribute("lt", new THREE.BufferAttribute(grown.lt, 4));
  const leafMat = new THREE.LineBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  leafMat.positionNode = positionLocal.add(swayN(positionLocal));
  {
    const a: N = attribute("a", "float");
    const k: N = attribute("k", "float");
    const lt: N = attribute("lt", "vec4");
    const warm: N = lt.x.mul(lightLevelN(lt.y, lt.z.max(1), lt.w)).mul(0.7).min(1);
    leafMat.colorNode = mix(mix(woodC, needleC, k), warmC, warm.mul(0.45));
    leafMat.opacityNode = a
      .mul(opts.lite ? 0.6 : 0.5)
      .mul(float(1).add(warm.mul(1.1)))
      .mul(far.max(0.3))
      .mul(dof.max(0.12))
      .mul(nearFade)
      .mul(float(1).sub(markU.mul(0.15)))
      .mul(float(1).sub(focusU.mul(0.42)));
  }
  add(new THREE.LineSegments(leaves, leafMat), 1);

  // The bark and the roots: the same hairlines, the trunk's own.
  {
    const pos: number[] = [];
    const a: number[] = [];
    const push = (line: V3[], from: number, to: number) => {
      for (let i = 1; i < line.length; i++) {
        const p = line[i - 1] as V3;
        const q = line[i] as V3;
        pos.push(...p, ...q);
        a.push(from + (to - from) * ((i - 1) / (line.length - 1)));
        a.push(from + (to - from) * (i / (line.length - 1)));
      }
    };
    for (const l of grown.bark) push(l, 0.34, 0.2);
    for (const l of grown.roots) push(l, 0.3, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("a", new THREE.Float32BufferAttribute(a, 1));
    g.setAttribute("k", new THREE.Float32BufferAttribute(new Array(a.length).fill(0), 1));
    g.setAttribute("lt", new THREE.Float32BufferAttribute(new Array(a.length * 4).fill(0), 4));
    add(new THREE.LineSegments(g, leafMat), 1);
  }

  // ——— the trunk's axis, and the fronts of light that rise on it ———
  const N_T = ALL.length;
  const frontY = Array.from({ length: N_T }, () => uniform(-99));
  const frontAmp = Array.from({ length: N_T }, () => uniform(0));
  const frontCol = Array.from({ length: N_T }, () => uniform(new THREE.Color(COLOR.agent)));
  const hA: N = attribute("h", "float");
  const TAIL = 0.5;
  let wake: N = vec3(0, 0, 0);
  let wakeA: N = float(0);
  for (let i = 0; i < N_T; i++) {
    const d: N = (frontY[i] as N).sub(hA);
    const w: N = float(1)
      .sub(smoothstep(float(-0.02), float(0.07), d.negate()))
      .mul(exp(d.max(0).div(-TAIL)))
      .mul(frontAmp[i] as N);
    wake = wake.add((frontCol[i] as N).mul(w));
    wakeA = wakeA.add(w);
  }
  const axisMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  axisMat.positionNode = hairline(1.05);
  axisMat.colorNode = inkC.mul(0.9).add(wake.mul(1.3));
  axisMat.opacityNode = smoothstep(float(-1.0), float(0.3), hA)
    .mul(0.3)
    .add(wakeA.min(1).mul(0.75))
    .mul(far.add(0.35).min(1))
    .mul(float(1).sub(markU.mul(0.6)))
    .mul(float(1).sub(focusU.mul(0.3)))
    .mul(nearFade);
  {
    const ys: number[] = [];
    for (let y = ROOT_Y; y <= CROWN[1] + 1e-6; y += 0.04) ys.push(y);
    const pts = ys.map((y) => trunkAt(y));
    add(new THREE.Mesh(tube(pts, { h: ys }, 4), axisMat), 2);
  }

  // The ticks the tickets rise from, on the taproot.
  const tickG = new THREE.BufferGeometry();
  tickG.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 1, 2, 3].flatMap((r) => {
        const [x, y, z] = rowPoint(r);
        return [x - 0.05, y, z, x, y, z];
      }),
      3,
    ),
  );
  const tickMat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  tickMat.colorNode = inkC;
  tickMat.opacityNode = far.mul(0.32).mul(float(1).sub(markU)).mul(nearFade);
  add(new THREE.LineSegments(tickG, tickMat), 2);

  // ——— the soil: three faint contours and a pool of warm light the tree stands in ———
  {
    const pos: number[] = [];
    for (const r of [0.9, 1.75, 2.6]) {
      const n = 96;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU;
        const a1 = ((i + 1) / n) * TAU;
        pos.push(r * Math.cos(a0), GROUND, r * Math.sin(a0), r * Math.cos(a1), GROUND, r * Math.sin(a1));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
    const rad: N = positionLocal.xz.length();
    m.colorNode = inkC;
    m.opacityNode = float(0.1)
      .mul(smoothstep(float(2.8), float(0.6), rad))
      .mul(far)
      .mul(dof.max(0.2))
      .mul(float(1).sub(markU))
      .mul(nearFade);
    add(new THREE.LineSegments(g, m), 0);

    const pool = new THREE.Mesh(
      new THREE.CircleGeometry(3.2, 48).rotateX(-Math.PI / 2).translate(0, GROUND - 0.005, 0),
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    const pm = pool.material as THREE.MeshBasicNodeMaterial;
    const pr: N = positionLocal.xz.length().div(3.2);
    pm.colorNode = warmC;
    pm.opacityNode = exp(pr.mul(pr).mul(-5)).mul(0.022).mul(float(1).sub(markU)).mul(float(1).sub(focusU.mul(0.5)));
    add(pool, 0);
  }

  // ——— the lights: tickets resting on the branches. Each breathes on its own
  // long clock (no two alike, nothing synchronised, nothing that flickers), and
  // swells a while, then settles, when work lands on its branch. ———
  {
    const lp = new Float32Array(LN * 4);
    const lq = new Float32Array(LN * 4);
    grown.lights.forEach((L, i) => {
      lp.set([...L.p, L.ph], i * 4);
      lq.set([L.per, L.tl, L.size, 0], i * 4);
    });
    const A: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(lp, 4));
    const B: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(lq, 4));
    const level: N = lightLevelN(A.w, B.x, B.y);
    const base: N = A.xyz;
    /** World size of `px` CSS pixels at this point's depth, grown a little when out of focus. */
    const px = (n: number): N => {
      const dc: N = viewDepth(base.add(swayN(base)));
      const coc: N = dc.sub(camDist).abs().div(camDist);
      return dc.mul(pxU).mul(2).mul(n).mul(float(1).add(coc.mul(2.2)));
    };
    const defocus: N = float(1).div(float(1).add(depth.sub(camDist).abs().div(camDist).mul(2.2)).pow(2));
    const mk = (size: N, alpha: N, order: number, core: boolean) => {
      const m = new THREE.SpriteNodeMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      m.positionNode = base.add(swayN(base));
      m.scaleNode = size;
      const d: N = uv().sub(0.5).length().mul(2);
      const body: N = core
        ? float(1).sub(smoothstep(float(0.5), float(0.95), d))
        : exp(d.mul(d).mul(-5)).sub(0.006).max(0);
      m.colorNode = warmC;
      m.opacityNode = body.mul(alpha).mul(defocus.max(0.2)).mul(nearFade).mul(float(1).sub(markU));
      const s = new THREE.Sprite(m);
      s.count = LN;
      s.frustumCulled = false;
      add(s, order);
    };
    mk(px(30).mul(B.z.mul(0.5).add(0.6)).mul(level.mul(0.45).add(0.55)), level.mul(0.15), 5, false);
    mk(px(3.6).mul(B.z.mul(0.3).add(0.8)), level.mul(0.85).min(1), 6, true);
  }

  // ——— embers: a few warm points drifting slowly up out of the branches ———
  {
    const E = opts.lite ? 7 : 16;
    const eb = new Float32Array(E * 4);
    for (let i = 0; i < E; i++) {
      const t = grown.tips[Math.floor(rand(i, 31) * grown.tips.length)] as V3;
      eb.set([t[0], t[1], t[2], rand(i, 32)], i * 4);
    }
    const mb: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(eb, 4));
    const ph: N = mb.w;
    const f: N = clockU.mul(0.011).mul(ph.mul(0.6).add(0.7)).add(ph.mul(7)).fract();
    const m = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const at: N = vec3(
      mb.x.add(sin(clockU.mul(0.17).add(ph.mul(40))).mul(0.12)),
      mb.y.add(f.mul(1.9)),
      mb.z.add(sin(clockU.mul(0.13).add(ph.mul(70))).mul(0.12)),
    );
    m.positionNode = at.add(swayN(at));
    const dc: N = viewDepth(at.add(swayN(at)));
    const coc: N = dc.sub(camDist).abs().div(camDist).mul(2.2).add(1);
    m.scaleNode = dc.mul(pxU).mul(2).mul(float(2.4).add(ph.mul(1.6))).mul(coc);
    const d: N = uv().sub(0.5).length().mul(2);
    m.colorNode = warmC;
    m.opacityNode = exp(d.mul(d).mul(-4))
      .mul(smoothstep(float(0), float(0.25), f))
      .mul(smoothstep(float(1), float(0.55), f))
      .mul(0.55)
      .mul(nearFade)
      .mul(float(1).sub(markU))
      .div(coc.mul(coc));
    const s = new THREE.Sprite(m);
    s.count = E;
    s.frustumCulled = false;
    add(s, 6);
  }

  // ——— the boughs, one per ticket, where it leaves the line ———
  interface Live {
    b: Bough;
    u: Record<
      | "grow"
      | "lit"
      | "progress"
      | "agent"
      | "bloom"
      | "back"
      | "alpha"
      | "agentTint"
      | "settle"
      | "bloomTint"
      | "ring",
      N
    >;
    agent: THREE.Sprite[];
    ring: THREE.Sprite;
    bud: THREE.Sprite[];
    back: THREE.Sprite[];
    settle: THREE.Sprite[];
  }
  const sAttr: N = attribute("s", "float");
  const lives: Live[] = ALL.map((b) => {
    const isF = b === FEATURED;
    const u = {
      grow: uniform(0),
      lit: uniform(0),
      progress: uniform(0),
      agent: uniform(0),
      bloom: uniform(0),
      back: uniform(0),
      alpha: uniform(1),
      settle: uniform(0),
      ring: uniform(0),
      agentTint: uniform(new THREE.Color(COLOR.agent)),
      bloomTint: uniform(new THREE.Color(COLOR.open)),
    };
    const dim: N = (isF ? float(1) : dimU).mul(u.alpha);
    const done: N = step(sAttr, u.progress);
    const STEPS = 48;
    const pts = Array.from({ length: STEPS + 1 }, (_, i) => boughAt(b, i / STEPS));
    const g = tube(pts, { s: pts.map((_, i) => i / STEPS) }, 4);
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    m.positionNode = hairline(1.15);
    // A soft leading edge as it grows; what the agent has covered reads a little brighter.
    const edgeIn: N = float(1).sub(smoothstep(u.grow.sub(0.06), u.grow, sAttr));
    m.colorNode = inkC;
    m.opacityNode = edgeIn
      .mul(u.lit)
      .mul(mix(float(0.42), float(0.8), done))
      .mul(far.add(0.3).min(1))
      .mul(nearFade)
      .mul(dim);
    add(new THREE.Mesh(g, m), 4);

    const sprite = (mat: THREE.SpriteNodeMaterial, order: number) =>
      add(new THREE.Sprite(mat), order);
    return {
      b,
      u,
      agent: [
        sprite(spriteMat("soft", u.agentTint, u.agent.mul(dim).mul(0.14)), 7),
        sprite(spriteMat("core", u.agentTint, u.agent.mul(dim).mul(0.95)), 8),
      ],
      ring: sprite(spriteMat("ring", u.agentTint, u.ring.mul(dim).mul(0.55)), 8),
      bud: [
        sprite(spriteMat("ring", u.bloomTint, u.bloom.mul(dim).mul(0.6)), 7),
        sprite(spriteMat("core", u.bloomTint, u.bloom.mul(dim).mul(0.9)), 8),
      ],
      settle: [
        sprite(spriteMat("soft", cnode(COLOR.light), u.settle.mul(0.2)), 6),
        sprite(spriteMat("core", cnode(COLOR.light), u.settle.mul(0.85)), 7),
      ],
      back: [
        sprite(spriteMat("soft", cnode(COLOR.accent), u.back.mul(dim).mul(0.14)), 7),
        sprite(spriteMat("core", cnode(COLOR.accent), u.back.mul(dim).mul(0.9)), 8),
      ],
    };
  });

  // ——— the crown: main's newest commit, a little brighter after every merge ———
  const crownU = uniform(0);
  const crown = [
    add(new THREE.Sprite(spriteMat("soft", cnode(COLOR.accent), crownU.mul(0.12).add(0.1))), 6),
    add(new THREE.Sprite(spriteMat("ring", cnode(COLOR.accent), float(0.38))), 7),
    add(new THREE.Sprite(spriteMat("core", cnode(COLOR.accent), float(0.95))), 8),
  ];
  for (const s of crown) s.position.set(...CROWN);

  // ——— the mark: the icon's two triangles, square to the camera, drawn out of the line ———
  const markGroup = new THREE.Group();
  scene.add(markGroup);
  {
    const pos: number[] = [];
    const per: number[] = [];
    for (const tri of MARK) {
      const corners = tri.map(([x, y]) => [x, y] as const);
      let acc = 0;
      const lens = corners.map((c, i) => {
        const d = corners[(i + 1) % 3] as readonly [number, number];
        return Math.hypot(d[0] - c[0], d[1] - c[1]);
      });
      const total = lens.reduce((a, b) => a + b, 0);
      corners.forEach((c, i) => {
        const d = corners[(i + 1) % 3] as readonly [number, number];
        const n = 40;
        for (let k = 0; k < n; k++) {
          const a0 = k / n;
          const a1 = (k + 1) / n;
          pos.push(
            c[0] + (d[0] - c[0]) * a0,
            c[1] + (d[1] - c[1]) * a0,
            0,
            c[0] + (d[0] - c[0]) * a1,
            c[1] + (d[1] - c[1]) * a1,
            0,
          );
          per.push(
            (acc + (lens[i] as number) * a0) / total,
            (acc + (lens[i] as number) * a1) / total,
          );
        }
        acc += lens[i] as number;
      });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("per", new THREE.Float32BufferAttribute(per, 1));
    const m = new THREE.LineBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const perA: N = attribute("per", "float");
    m.colorNode = cnode(COLOR.accent).mul(0.7);
    m.opacityNode = float(1)
      .sub(smoothstep(markU.mul(1.1).sub(0.08), markU.mul(1.1), perA))
      .mul(markU.min(1));
    const outline = new THREE.LineSegments(g, m);
    outline.renderOrder = 9;
    markGroup.add(outline);

    // The fill, the icon's emerald, rising from the bottom of each tier.
    const fp: number[] = [];
    const fh: number[] = [];
    for (const tri of MARK) {
      for (const [x, y] of tri) {
        fp.push(x, y, -0.001);
        fh.push((tri[0] as [number, number])[1] === y ? 1 : 0);
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute(fp, 3));
    fg.setAttribute("h", new THREE.Float32BufferAttribute(fh, 1));
    const fm = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const h: N = attribute("h", "float");
    fm.colorNode = mix(cnode("#0c6f59"), cnode("#c8f6e7"), h);
    fm.opacityNode = markU
      .sub(0.35)
      .max(0)
      .mul(0.03)
      .mul(mix(float(0.5), float(1), h));
    const fill = new THREE.Mesh(fg, fm);
    fill.renderOrder = 1;
    markGroup.add(fill);
  }

  // ——— output: a vignette and a fixed, fine grain. No bloom. ———
  const pipeline = new THREE.RenderPipeline(renderer);
  const sceneColor: N = pass(scene, camera).getTextureNode("output");
  const aspectU = uniform(1);
  const p: N = screenUV.sub(0.5).mul(vec2(aspectU, 1));
  const vignette: N = smoothstep(float(1.15), float(0.25), p.length());
  const n: N = fract(sin(screenUV.x.mul(12.9898).add(screenUV.y.mul(78.233))).mul(43758.5453));
  // A soft shoulder: where hairlines pile up, the light rolls off to white without turning yellow.
  const shoulder: N = sceneColor.rgb.div(sceneColor.rgb.mul(0.7).add(1)).mul(1.2);
  const graded: N = shoulder.mul(vignette.mul(0.3).add(0.7)).add(n.sub(0.5).mul(0.008));
  pipeline.outputNode = vec4(graded, 1);

  const v3 = new THREE.Vector3();
  let width = 1;
  let height = 1;

  function resize(w: number, h: number) {
    width = Math.max(1, w);
    height = Math.max(1, h);
    renderer.setSize(width, height, false);
    aspectU.value = width / height;
  }

  let tanHalf = 0.25;
  function setCamera(pose: Pose) {
    const v = viewOf(pose, width / height);
    camera.position.set(...v.eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(v3.set(...pose.target));
    camera.fov = pose.fov;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.projectionMatrix.elements[8] = v.sx;
    camera.projectionMatrix.elements[9] = v.sy;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    camDist.value = pose.dist;
    tanHalf = Math.tan((pose.fov * Math.PI) / 360);
    pxU.value = tanHalf / height;
    markGroup.rotation.y = pose.az;
    return v;
  }

  /** World size of a sprite that is `px` CSS pixels across at point p. */
  const sizeAt = (v: ReturnType<typeof viewOf>, p: V3, px: number) => {
    const d =
      (p[0] - v.eye[0]) * -v.b[0] + (p[1] - v.eye[1]) * -v.b[1] + (p[2] - v.eye[2]) * -v.b[2];
    return Math.max(0.001, d) * (tanHalf / height) * 2 * px;
  };

  function render(f: Frame) {
    const v = setCamera(f.pose);
    dimU.value = 1 - 0.55 * f.focus;
    markU.value = f.mark;
    focusU.value = f.focus;
    clockU.value = f.t;
    const W = (p: V3) => swayP(p, f.t);
    let flash = 0;
    lives.forEach((live, i) => {
      const { b, u } = live;
      const isF = b === FEATURED;
      const st = stateAt(b, isF ? f.featured.u : f.t + b.offset);
      const presence = (isF ? f.featured.alpha : 1 - 0.55 * f.focus) * (1 - f.mark);
      u.alpha.value = isF ? f.featured.alpha * (1 - f.mark) : 1 - f.mark;
      u.grow.value = st.grow;
      u.lit.value = st.lit;
      u.progress.value =
        st.stage === "pr" || st.stage === "merged" || st.stage === "back" ? 1.01 : st.progress;
      u.agentTint.value.set(st.asking ? COLOR.ask : COLOR.agent);
      // Working fades in with the bough; "needs you" is a steady warm hold.
      u.agent.value = st.stage === "work" ? Math.min(1, st.progress * 12 + 0.25) : 0;
      u.ring.value = st.asking ? 1 : 0;
      u.bloomTint.value.set(COLOR.open);
      u.bloom.value = st.bloom;

      // The front of light this ticket has on the line: rising to its fork, or climbing to the crown.
      let front = -99;
      let amp = 0;
      if (st.bead > -90) {
        front = st.bead;
        amp = 1;
        (frontCol[i] as N).value.set(COLOR.agent);
      } else if (st.back && "y" in st.back) {
        front = st.back.y;
        amp = 1;
        (frontCol[i] as N).value.set(COLOR.accent);
      }
      (frontY[i] as N).value = front;
      (frontAmp[i] as N).value = amp * presence * 0.9;

      const at = W(boughAt(b, Math.max(0.02, Math.min(1, st.progress))));
      for (const s of live.agent) s.position.set(...at);
      live.agent[0]?.scale.setScalar(sizeAt(v, at, st.asking ? 30 : 24));
      live.agent[1]?.scale.setScalar(sizeAt(v, at, 4.5));
      live.ring.position.set(...at);
      live.ring.scale.setScalar(sizeAt(v, at, 17));
      const tip = W(boughAt(b, 1));
      for (const s of live.bud) s.position.set(...tip);
      u.settle.value = st.settled * (isF ? f.featured.alpha : 1) * (1 - f.mark);
      for (const s of live.settle) s.position.set(...tip);
      live.settle[0]?.scale.setScalar(sizeAt(v, tip, 26));
      live.settle[1]?.scale.setScalar(sizeAt(v, tip, 3.6));
      live.bud[0]?.scale.setScalar(sizeAt(v, tip, 11));
      live.bud[1]?.scale.setScalar(sizeAt(v, tip, 3.4));

      const showBack = st.back && "s" in st.back;
      u.back.value = showBack ? 1 : 0;
      if (st.back && showBack) {
        const q = W(backPoint(b, st.back));
        for (const s of live.back) s.position.set(...q);
        live.back[0]?.scale.setScalar(sizeAt(v, q, 22));
        live.back[1]?.scale.setScalar(sizeAt(v, q, 4));
      }
      flash += st.flash * presence;
    });
    const fl = Math.min(1, flash);
    crownU.value = fl;
    crown[0]?.scale.setScalar(sizeAt(v, CROWN, 22 + 10 * fl));
    crown[1]?.scale.setScalar(sizeAt(v, CROWN, 12));
    crown[2]?.scale.setScalar(sizeAt(v, CROWN, 4.2));
    pipeline.render();
  }

  return {
    backend: backendName,
    render,
    resize,
    dispose() {
      pipeline.dispose();
      renderer.dispose();
    },
  };
}
