/**
 * The live tree. Its own chunk: three/webgpu and the TSL graph load only when
 * the stage asks for them, after the poster has painted.
 *
 * WebGPURenderer runs on WebGPU where the browser has it and on three's
 * WebGL2 backend where it does not; every material is a TSL node material,
 * so one graph compiles to WGSL or GLSL. Materials are built once and driven
 * by uniforms (a graph rebuilt at runtime recompiles its shaders).
 *
 * What it draws is model.ts: one line winding up santree's two tiers, with
 * fine needles along it; beads of light running on it, each leaving a short
 * glowing wake on the line itself; the lit boughs where tickets leave it; the
 * crown; and, at the end of the scroll, the mark resolving out of the line.
 * The far side of every stroke drops back, as an engraver does it; only the
 * lights are bright enough to bloom; motes drift and go soft away from the
 * focal plane; the output pass adds a vignette and a fine grain.
 */
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  abs,
  attribute,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  max,
  mix,
  pass,
  positionView,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  color as tslColor,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import * as THREE from "three/webgpu";
import {
  ALL,
  type Bough,
  backPoint,
  boughAt,
  COLOR,
  CROWN,
  FEATURED,
  LINE,
  lineAt,
  MARK,
  type Pose,
  rand,
  rowPoint,
  stateAt,
  type V3,
  viewOf,
} from "./model";

export interface Frame {
  pose: Pose;
  /** Wall time, seconds since the page opened. */
  t: number;
  /** QK-138's place in its life (seconds into its loop), and how present it is. */
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

/** A tube along a polyline, its radius r(i), each ring carrying the attributes in `attrs`. */
function tube(
  pts: V3[],
  radius: (i: number) => number,
  attrs: Record<string, number[]>,
  sides = 5,
) {
  const pos: number[] = [];
  const index: number[] = [];
  const out: Record<string, number[]> = Object.fromEntries(Object.keys(attrs).map((k) => [k, []]));
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3();
  const n1 = new THREE.Vector3();
  const n2 = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    n1.crossVectors(t, Math.abs(t.y) > 0.95 ? side : up).normalize();
    n2.crossVectors(t, n1).normalize();
    const r = radius(i);
    const p = pts[i]!;
    for (let j = 0; j < sides; j++) {
      const ang = (j / sides) * Math.PI * 2;
      const c = Math.cos(ang) * r;
      const d = Math.sin(ang) * r;
      pos.push(p[0] + n1.x * c + n2.x * d, p[1] + n1.y * c + n2.y * d, p[2] + n1.z * c + n2.z * d);
      for (const k of Object.keys(attrs)) out[k]!.push(attrs[k]![i]!);
      if (i < pts.length - 1) {
        const q = i * sides;
        const j1 = (j + 1) % sides;
        index.push(q + j, q + sides + j, q + j1, q + j1, q + sides + j, q + sides + j1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  for (const k of Object.keys(out)) g.setAttribute(k, new THREE.Float32BufferAttribute(out[k]!, 1));
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
  const dimU = uniform(1);
  const markU = uniform(0);
  const focusU = uniform(0);
  const inkC = cnode(COLOR.ink);
  const leafC = cnode("#cfe6dc");

  /** The far side drops back; whatever brushes the lens fades out. */
  const depth: N = positionView.z.negate();
  const far: N = mix(float(0.2), float(1), smoothstep(camDist.add(1.7), camDist.sub(1.1), depth));
  const nearFade: N = smoothstep(float(0.35), float(1.3), depth);
  const engrave: N = far.mul(nearFade);

  type Shape = "soft" | "ring" | "core";
  function spriteMat(shape: Shape, tint: N, alpha: N, gain: number) {
    const m = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const d: N = uv().sub(0.5).length().mul(2);
    const body: N =
      shape === "soft"
        ? exp(d.mul(d).mul(-5.5)).sub(0.004).max(0)
        : shape === "ring"
          ? smoothstep(float(0.66), float(0.78), d).mul(
              float(1).sub(smoothstep(float(0.84), float(0.97), d)),
            )
          : float(1).sub(smoothstep(float(0.3), float(0.8), d));
    m.colorNode = tint.mul(gain);
    m.opacityNode = body.mul(alpha).mul(nearFade);
    return m;
  }
  const add = <T extends THREE.Object3D>(o: T, order = 0) => {
    o.renderOrder = order;
    scene.add(o);
    return o;
  };

  // ——— the line, and the lights that run on it ———
  const N_T = ALL.length;
  const lightSig = Array.from({ length: N_T }, () => uniform(-1));
  const lightAmp = Array.from({ length: N_T }, () => uniform(0));
  const lightCol = Array.from({ length: N_T }, () => uniform(new THREE.Color(COLOR.triage)));
  const sig: N = attribute("sig", "float");
  /** A wake behind each light, 1.8 m long, and a short halo ahead of it. */
  const WAKE = 1.8 / LINE.length;
  const HALO = 0.12 / LINE.length;
  let wake: N = vec3(0, 0, 0);
  let wakeA: N = float(0);
  for (let i = 0; i < N_T; i++) {
    const d: N = lightSig[i]!.sub(sig);
    const w: N = step(float(0), d)
      .mul(exp(d.div(-WAKE)))
      .add(exp(abs(d).div(-HALO)).mul(0.6))
      .mul(lightAmp[i]!);
    wake = wake.add(lightCol[i]!.mul(w));
    wakeA = wakeA.add(w);
  }
  const lineMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  lineMat.colorNode = inkC.mul(0.92).add(wake.mul(2.4));
  lineMat.opacityNode = max(
    float(0.6)
      .mul(far)
      .mul(float(1).sub(markU.mul(0.55)))
      .mul(float(1).sub(focusU.mul(0.4))),
    wakeA.min(1).mul(far.add(0.4).min(1)),
  ).mul(nearFade);
  const L = LINE.pts.length;
  add(
    new THREE.Mesh(
      tube(
        LINE.pts,
        (i) => (LINE.part[i] === "root" ? 0.006 : 0.0075),
        { sig: LINE.sig },
        opts.lite ? 4 : 5,
      ),
      lineMat,
    ),
    2,
  );

  // Needles along the windings: a fir's, short and down-and-out, alternating sides.
  const needles: number[] = [];
  const step0 = opts.lite ? 7 : 4;
  for (let i = 0; i < L - 1; i += step0) {
    const part = LINE.part[i];
    if (part !== "lower" && part !== "upper" && part !== "floor" && part !== "gap") continue;
    const p = LINE.pts[i]!;
    const q = LINE.pts[i + 1]!;
    const tx = q[0] - p[0];
    const tz = q[2] - p[2];
    const tl = Math.hypot(tx, tz) || 1;
    const rad = Math.hypot(p[0], p[2]) || 1;
    const k = (i / step0) % 2 === 0 ? 1 : -1;
    const len = 0.03 + 0.015 * rand(i, 7);
    const dx = (p[0] / rad) * 0.45 + (tx / tl) * 0.5 * k;
    const dz = (p[2] / rad) * 0.45 + (tz / tl) * 0.5 * k;
    const dy = -0.75;
    const n = Math.hypot(dx, dy, dz);
    needles.push(
      p[0],
      p[1],
      p[2],
      p[0] + (dx / n) * len,
      p[1] + (dy / n) * len,
      p[2] + (dz / n) * len,
    );
  }
  const needleG = new THREE.BufferGeometry();
  needleG.setAttribute("position", new THREE.Float32BufferAttribute(needles, 3));
  const needleMat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  needleMat.colorNode = leafC;
  needleMat.opacityNode = engrave.mul(0.2).mul(float(1).sub(markU.mul(0.7)));
  add(new THREE.LineSegments(needleG, needleMat), 1);

  // The ledger's ticks on the taproot.
  const tickG = new THREE.BufferGeometry();
  tickG.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 1, 2, 3, 4, 5].flatMap((r) => {
        const [x, y, z] = rowPoint(r);
        return [x - 0.05, y, z, x, y, z];
      }),
      3,
    ),
  );
  const tickMat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  tickMat.colorNode = inkC;
  tickMat.opacityNode = engrave.mul(0.6);
  add(new THREE.LineSegments(tickG, tickMat), 2);

  // ——— the motes: a slow drift of light, soft away from the focal plane ———
  const MOTES = opts.lite ? 200 : 460;
  const moteBase = new Float32Array(MOTES * 4);
  for (let i = 0; i < MOTES; i++) {
    const a = rand(i, 21) * Math.PI * 2;
    const r = 0.6 + 4.6 * Math.sqrt(rand(i, 22));
    moteBase.set([r * Math.cos(a), -1 + 6.6 * rand(i, 23), r * Math.sin(a), rand(i, 24)], i * 4);
  }
  const mb: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(moteBase, 4));
  const ph: N = mb.w;
  const rise: N = fract(
    mb.y
      .add(1)
      .div(6.6)
      .add(time.mul(0.005).mul(ph.add(0.4))),
  )
    .mul(6.6)
    .sub(1);
  const moteMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  moteMat.positionNode = vec3(
    mb.x.add(sin(time.mul(0.11).add(ph.mul(40))).mul(0.12)),
    rise,
    mb.z.add(sin(time.mul(0.09).add(ph.mul(70))).mul(0.12)),
  );
  const coc: N = abs(depth.sub(camDist)).mul(0.45).add(1);
  moteMat.sizeNode = float(0.02).add(ph.mul(0.028)).mul(coc);
  const md: N = uv().sub(0.5).length().mul(2);
  const edge: N = smoothstep(float(-1), float(-0.4), rise).mul(
    smoothstep(float(5.6), float(4.6), rise),
  );
  moteMat.colorNode = inkC;
  moteMat.opacityNode = exp(md.mul(md).mul(-4)).mul(edge).mul(nearFade).mul(0.38).div(coc.mul(coc));
  const motes = new THREE.Sprite(moteMat);
  motes.count = MOTES;
  motes.frustumCulled = false;
  add(motes, 3);

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
      | "bead"
      | "alpha"
      | "agentTint"
      | "bloomTint"
      | "backTint",
      N
    >;
    agent: THREE.Sprite[];
    bud: THREE.Sprite[];
    bead: THREE.Sprite[];
    back: THREE.Sprite[];
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
      bead: uniform(0),
      alpha: uniform(1),
      agentTint: uniform(new THREE.Color(COLOR.claude)),
      bloomTint: uniform(new THREE.Color(COLOR.open)),
      backTint: uniform(new THREE.Color(COLOR.merged)),
    };
    const dim: N = (isF ? float(1) : dimU).mul(u.alpha);
    const done: N = step(sAttr, u.progress);
    const STEPS = 48;
    const pts = Array.from({ length: STEPS + 1 }, (_, i) => boughAt(b, i / STEPS));
    const s = pts.map((_, i) => i / STEPS);
    const g = tube(pts, (i) => 0.0125 * (1 - 0.5 * (i / STEPS)), { s }, 6);
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // A soft leading edge as it grows, and the agent's colour in what it has done.
    const edgeIn: N = float(1).sub(smoothstep(u.grow.sub(0.06), u.grow, sAttr));
    m.colorNode = mix(inkC, u.agentTint, done.mul(0.3).add(0.12)).mul(1.4);
    m.opacityNode = edgeIn
      .mul(u.lit)
      .mul(mix(float(0.55), float(1), done))
      .mul(far.add(0.3).min(1))
      .mul(nearFade)
      .mul(dim);
    add(new THREE.Mesh(g, m), 4);

    // its needles, a little longer than the line's: a bough, not a twig
    const nd: number[] = [];
    const ns: number[] = [];
    for (let i = 2; i < STEPS; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      const tx = q[0] - p[0];
      const tz = q[2] - p[2];
      const tl = Math.hypot(tx, tz) || 1;
      for (const k of [1, -1]) {
        const len = 0.06 * (1 - (0.5 * i) / STEPS);
        const dx = (-tz / tl) * 0.7 * k + (tx / tl) * 0.4;
        const dz = (tx / tl) * 0.7 * k + (tz / tl) * 0.4;
        const dy = -0.6;
        const n = Math.hypot(dx, dy, dz);
        nd.push(
          p[0],
          p[1],
          p[2],
          p[0] + (dx / n) * len,
          p[1] + (dy / n) * len,
          p[2] + (dz / n) * len,
        );
        ns.push(i / STEPS, i / STEPS);
      }
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", new THREE.Float32BufferAttribute(nd, 3));
    ng.setAttribute("s", new THREE.Float32BufferAttribute(ns, 1));
    const nm = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
    nm.colorNode = inkC;
    nm.opacityNode = step(sAttr, u.grow).mul(u.lit).mul(0.6).mul(engrave).mul(dim);
    add(new THREE.LineSegments(ng, nm), 4);

    const sprite = (mat: THREE.SpriteNodeMaterial, order: number) =>
      add(new THREE.Sprite(mat), order);
    return {
      b,
      u,
      agent: [
        sprite(spriteMat("soft", u.agentTint, u.agent.mul(dim).mul(0.9), 1.3), 7),
        sprite(spriteMat("core", u.agentTint, u.agent.mul(dim), 3.2), 8),
      ],
      bud: [
        sprite(spriteMat("soft", u.bloomTint, u.bloom.mul(0.7).mul(dim), 1.2), 6),
        sprite(spriteMat("ring", u.bloomTint, u.bloom.mul(dim), 1.6), 7),
        sprite(spriteMat("core", u.bloomTint, u.bloom.mul(dim), 2.6), 8),
      ],
      bead: [
        sprite(spriteMat("soft", cnode(COLOR.triage), u.bead.mul(dim).mul(0.8), 1.2), 7),
        sprite(spriteMat("core", cnode(COLOR.triage), u.bead.mul(dim), 2.8), 8),
      ],
      back: [
        sprite(spriteMat("soft", u.backTint, u.back.mul(dim).mul(0.85), 1.3), 7),
        sprite(spriteMat("core", u.backTint, u.back.mul(dim), 3.2), 8),
      ],
    };
  });

  // ——— the crown: main's newest commit, brighter on every merge ———
  const crownU = uniform(0.5);
  const crown = [
    add(new THREE.Sprite(spriteMat("soft", cnode(COLOR.accent), crownU.mul(0.55), 1.1)), 6),
    add(new THREE.Sprite(spriteMat("ring", cnode(COLOR.accent), crownU.min(1), 1.1)), 7),
    add(new THREE.Sprite(spriteMat("core", cnode(COLOR.accent), crownU.min(1), 3)), 8),
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
        const d = corners[(i + 1) % 3]!;
        return Math.hypot(d[0] - c[0], d[1] - c[1]);
      });
      const total = lens.reduce((a, b) => a + b, 0);
      corners.forEach((c, i) => {
        const d = corners[(i + 1) % 3]!;
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
          per.push((acc + lens[i]! * a0) / total, (acc + lens[i]! * a1) / total);
        }
        acc += lens[i]!;
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
    m.colorNode = cnode(COLOR.accent).mul(1.6);
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
        fh.push(tri[0]![1] === y ? 1 : 0);
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
      .mul(0.42)
      .mul(mix(float(0.5), float(1), h));
    const fill = new THREE.Mesh(fg, fm);
    fill.renderOrder = 1;
    markGroup.add(fill);
  }

  // ——— output: bloom on the lights, then vignette and grain ———
  const pipeline = new THREE.RenderPipeline(renderer);
  const sceneColor: N = pass(scene, camera).getTextureNode("output");
  const glow: N = bloom(sceneColor, opts.lite ? 0.8 : 0.9, 0.55, 0.8);
  const aspectU = uniform(1);
  const p: N = screenUV.sub(0.5).mul(vec2(aspectU, 1));
  const vignette: N = smoothstep(float(1.15), float(0.25), p.length());
  const n: N = fract(
    sin(screenUV.x.mul(12.9898).add(screenUV.y.mul(78.233)).add(time.mul(7.1))).mul(43758.5453),
  );
  const graded: N = sceneColor.rgb
    .add(glow.rgb)
    .mul(vignette.mul(0.3).add(0.7))
    .add(n.sub(0.5).mul(0.01));
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

  let LS = 1;
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
    // Lights grow as the camera comes close, but slower than the world does.
    LS = (pose.dist / 12.6) ** 0.68;
    markGroup.rotation.y = pose.az;
  }

  function render(f: Frame) {
    setCamera(f.pose);
    dimU.value = 1 - 0.6 * f.focus;
    markU.value = f.mark;
    focusU.value = f.focus;
    let flash = 0;
    lives.forEach((live, i) => {
      const { b, u } = live;
      const isF = b === FEATURED;
      const st = stateAt(b, isF ? f.featured.u : f.t + b.offset);
      const presence = (isF ? f.featured.alpha : 1 - 0.6 * f.focus) * (1 - f.mark);
      u.alpha.value = isF ? f.featured.alpha * (1 - f.mark) : 1 - f.mark;
      u.grow.value = st.grow;
      u.lit.value = st.lit;
      u.progress.value =
        st.stage === "pr" || st.stage === "merged" || st.stage === "back" ? 1.01 : st.progress;
      const agentHex = b.agent === "claude" ? COLOR.claude : COLOR.codex;
      u.agentTint.value.set(st.asking ? COLOR.permission : agentHex);
      // "Needs you" breathes: a slow sine, never a strobe.
      const pulse = st.asking ? 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(f.t * 3.4)) : 1;
      u.agent.value = st.stage === "work" ? Math.min(1, st.progress * 30 + 0.3) * pulse : 0;
      u.bloomTint.value.set(
        st.stage === "merged" || st.stage === "back" ? COLOR.merged : COLOR.open,
      );
      u.bloom.value = st.bloom;

      // The one light this ticket has on the line: its bead coming in, or its merge climbing.
      let onLine = -1;
      let amp = 0;
      if (st.bead >= 0) {
        onLine = st.bead;
        amp = 1;
        lightCol[i]!.value.set(COLOR.triage);
      } else if (st.back && "sigma" in st.back) {
        onLine = st.back.sigma;
        amp = 1;
        lightCol[i]!.value.set(COLOR.accent);
      }
      lightSig[i]!.value = onLine;
      lightAmp[i]!.value = amp * presence * 0.9;

      u.bead.value = st.bead >= 0 ? 1 : 0;
      if (st.bead >= 0) for (const s of live.bead) s.position.set(...lineAt(st.bead));
      live.bead[0]!.scale.setScalar(0.26 * LS);
      live.bead[1]!.scale.setScalar(0.045 * LS);

      const at = boughAt(b, Math.max(0.02, Math.min(1, st.progress)));
      for (const s of live.agent) s.position.set(...at);
      live.agent[0]!.scale.setScalar((st.asking ? 0.56 : b.agent === "codex" ? 0.28 : 0.36) * LS);
      live.agent[1]!.scale.setScalar(0.055 * LS);
      const tip = boughAt(b, 1);
      for (const s of live.bud) s.position.set(...tip);
      live.bud[0]!.scale.setScalar(0.4 * LS);
      live.bud[1]!.scale.setScalar((0.09 + 0.05 * st.bloom) * LS);
      live.bud[2]!.scale.setScalar(0.05 * LS);

      u.backTint.value.set(st.back && "sigma" in st.back ? COLOR.accent : COLOR.merged);
      u.back.value = st.back ? 1 : 0;
      if (st.back) for (const s of live.back) s.position.set(...backPoint(b, st.back));
      live.back[0]!.scale.setScalar(0.3 * LS);
      live.back[1]!.scale.setScalar(0.05 * LS);
      flash += st.flash * presence;
    });
    crownU.value = (0.5 + 1.5 * flash) * (1 - 0.5 * f.mark) + 0.4 * f.mark;
    crown[0]!.scale.setScalar((0.3 + 0.3 * Math.min(1, flash)) * LS);
    crown[1]!.scale.setScalar((0.1 + 0.05 * Math.min(1, flash)) * LS);
    crown[2]!.scale.setScalar(0.048 * LS);
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
