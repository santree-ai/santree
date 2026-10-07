/**
 * The live tree. Its own chunk: three/webgpu and the TSL graph load only when
 * the stage asks for them, after the poster has painted.
 *
 * WebGPURenderer runs on WebGPU where the browser has it and on three's
 * WebGL2 backend where it does not; every material is a TSL node material,
 * so one graph compiles to WGSL or GLSL. Materials are built once and driven
 * by uniforms (a graph rebuilt at runtime recompiles its shaders).
 *
 * What it draws is model.ts: one hairline winding up santree's two tiers
 * inside two glass cones that carry the icon's silhouette; a front of light
 * that rises to a ticket's fork; the lit boughs where tickets leave the line;
 * small precise points for what is alive; the crown; and, at the end of the
 * scroll, the mark resolving out of the line.
 *
 * Restraint is the look. Every stroke is a constant few device pixels wide
 * whatever the distance (the line is built at unit width and scaled by its own
 * depth in the vertex stage), the far side drops back, lights are points a
 * few pixels across with a faint halo, there is no bloom, and nothing blinks.
 */
import {
  abs,
  attribute,
  cameraViewMatrix,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  mix,
  normalView,
  pass,
  positionLocal,
  positionView,
  pow,
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
  CONES,
  CROWN,
  FEATURED,
  LINE,
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
  const inkC = cnode(COLOR.ink);

  /** The far side drops back; whatever brushes the lens fades out. */
  const depth: N = positionView.z.negate();
  const far: N = mix(float(0.18), float(1), smoothstep(camDist.add(1.7), camDist.sub(1.1), depth));
  const nearFade: N = smoothstep(float(0.35), float(1.3), depth);

  /** Vertex stage of a hairline: unit tube scaled to `px` CSS pixels, a touch thinner when far. */
  function hairline(px: number): N {
    const c: N = attribute("ctr", "vec3");
    const d: N = cameraViewMatrix.mul(vec4(c, 1)).z.negate();
    const near: N = smoothstep(camDist.add(1.8), camDist.sub(1.2), d);
    const w: N = mix(float(0.62), float(1.12), near).mul(px);
    return c.add(positionLocal.sub(c).mul(d.mul(pxU).mul(w)));
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

  // ——— the two glass cones: the icon's silhouette, rim-lit, barely there ———
  const coneMats: N[] = [];
  for (const c of CONES) {
    const h = c.apex - c.base;
    const g = new THREE.ConeGeometry(c.r, h, 72, 1, true);
    g.translate(0, c.base + h / 2, 0);
    const m = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const hh: N = positionLocal.y.sub(c.base).div(h).clamp(0, 1);
    m.colorNode = mix(cnode("#0e6f59"), cnode("#b7f0dd"), hh);
    const rim: N = pow(float(1).sub(abs(normalView.z)), 2.4);
    m.opacityNode = rim
      .mul(0.2)
      .add(0.016)
      .mul(far)
      .mul(float(1).sub(markU))
      .mul(float(1).sub(focusU.mul(0.8)));
    coneMats.push(m);
    add(new THREE.Mesh(g, m), 0);
  }

  // ——— the line, and the fronts of light that rise on it ———
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
  const lineMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  lineMat.positionNode = hairline(opts.lite ? 1.0 : 0.9);
  lineMat.colorNode = inkC.mul(0.9).add(wake.mul(1.3));
  lineMat.opacityNode = float(0.5)
    .mul(far)
    .add(wakeA.min(1).mul(0.75).mul(far.add(0.35).min(1)))
    .mul(float(1).sub(markU.mul(0.6)))
    .mul(float(1).sub(focusU.mul(0.4)))
    .mul(nearFade);
  {
    const stride = opts.lite ? 2 : 1;
    const pts: V3[] = [];
    const hs: number[] = [];
    for (let i = 0; i < LINE.pts.length; i += stride) {
      pts.push(LINE.pts[i] as V3);
      hs.push((LINE.pts[i] as V3)[1]);
    }
    add(new THREE.Mesh(tube(pts, { h: hs }, 4), lineMat), 2);
  }

  // The trunk reads as a trunk: the taproot again, a little heavier, fading toward its foot.
  {
    const pts = LINE.pts.slice(0, 41);
    const trunk = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    trunk.positionNode = hairline(1.7);
    const hv: N = attribute("h", "float");
    trunk.colorNode = inkC;
    trunk.opacityNode = smoothstep(float(-1.0), float(0.1), hv)
      .mul(0.55)
      .mul(far)
      .mul(float(1).sub(markU))
      .mul(nearFade);
    add(new THREE.Mesh(tube(pts, { h: pts.map((p) => p[1]) }, 4), trunk), 2);
  }

  // The ticks the tickets rise from, on the taproot.
  const tickG = new THREE.BufferGeometry();
  tickG.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 1, 2, 3].flatMap((r) => {
        const [x, y, z] = rowPoint(r);
        return [x - 0.04, y, z, x, y, z];
      }),
      3,
    ),
  );
  const tickMat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false });
  tickMat.colorNode = inkC;
  tickMat.opacityNode = far.mul(0.32).mul(float(1).sub(markU)).mul(nearFade);
  add(new THREE.LineSegments(tickG, tickMat), 2);

  // ——— the motes: a very slow drift, a few, soft away from the focal plane ———
  const MOTES = opts.lite ? 40 : 90;
  const moteBase = new Float32Array(MOTES * 4);
  for (let i = 0; i < MOTES; i++) {
    const a = rand(i, 21) * Math.PI * 2;
    const r = 0.8 + 4.2 * Math.sqrt(rand(i, 22));
    moteBase.set([r * Math.cos(a), -1 + 6.6 * rand(i, 23), r * Math.sin(a), rand(i, 24)], i * 4);
  }
  const mb: N = instancedBufferAttribute(new THREE.InstancedBufferAttribute(moteBase, 4));
  const ph: N = mb.w;
  const rise: N = fract(
    mb.y
      .add(1)
      .div(6.6)
      .add(time.mul(0.003).mul(ph.add(0.4))),
  )
    .mul(6.6)
    .sub(1);
  const moteMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  moteMat.positionNode = vec3(
    mb.x.add(sin(time.mul(0.07).add(ph.mul(40))).mul(0.1)),
    rise,
    mb.z.add(sin(time.mul(0.06).add(ph.mul(70))).mul(0.1)),
  );
  const coc: N = abs(depth.sub(camDist)).mul(0.45).add(1);
  moteMat.sizeNode = float(0.016).add(ph.mul(0.02)).mul(coc);
  const md: N = uv().sub(0.5).length().mul(2);
  const edge: N = smoothstep(float(-1), float(-0.4), rise).mul(
    smoothstep(float(5.6), float(4.6), rise),
  );
  moteMat.colorNode = inkC;
  moteMat.opacityNode = exp(md.mul(md).mul(-4)).mul(edge).mul(nearFade).mul(0.2).div(coc.mul(coc));
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
      | "alpha"
      | "agentTint"
      | "bloomTint"
      | "ring",
      N
    >;
    agent: THREE.Sprite[];
    ring: THREE.Sprite;
    bud: THREE.Sprite[];
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
      alpha: uniform(1),
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
    m.colorNode = cnode(COLOR.accent).mul(1.1);
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
      .mul(0.38)
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
  const graded: N = sceneColor.rgb.mul(vignette.mul(0.3).add(0.7)).add(n.sub(0.5).mul(0.008));
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

      const at = boughAt(b, Math.max(0.02, Math.min(1, st.progress)));
      for (const s of live.agent) s.position.set(...at);
      live.agent[0]?.scale.setScalar(sizeAt(v, at, st.asking ? 30 : 24));
      live.agent[1]?.scale.setScalar(sizeAt(v, at, 4.5));
      live.ring.position.set(...at);
      live.ring.scale.setScalar(sizeAt(v, at, 17));
      const tip = boughAt(b, 1);
      for (const s of live.bud) s.position.set(...tip);
      live.bud[0]?.scale.setScalar(sizeAt(v, tip, 11));
      live.bud[1]?.scale.setScalar(sizeAt(v, tip, 3.4));

      const showBack = st.back && "s" in st.back;
      u.back.value = showBack ? 1 : 0;
      if (st.back && showBack) {
        const q = backPoint(b, st.back);
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
