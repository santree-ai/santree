import { useEffect, useRef } from "react";
import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import type { Engine } from "./engine";
import { AGENT_LAYER_SHIPPED, LAYER } from "./agent-layer";
import { swayP } from "./grow";
import {
  ALL,
  boughAt,
  CROWN,
  DOT_COLOR,
  DOT_WORD,
  END_S,
  ease,
  FEATURED,
  featuredAt,
  heroPose,
  keys,
  markAt,
  type Pose,
  poseAt,
  project,
  rowPoint,
  STATIONS_S,
  stateAt,
  type V3,
  viewOf,
} from "./model";
import { TreePoster } from "./poster";
import { type Crop, cropAspect, PROMPT, SCREEN_H, SCREEN_W, STATIONS, screenSrc } from "./stations";

/**
 * The hero and the scroll through the tree, one sticky stage.
 *
 * Two layouts, chosen before first paint by an inline script in the
 * document head (`html.pin`, see __root.tsx), so the prerendered page never
 * reflows into the other:
 *
 * - pin (wide screens, motion allowed): the stage holds while the page
 *   scrolls through END_S viewport heights. The camera leaves the hero, goes
 *   down to the roots and follows QK-138 out along its bough and back up
 *   main; at each station the real capture rides beside the tree as a glass
 *   pane, its leader line pinned to the 3D point it belongs to.
 * - list (phones, reduced motion, no GPU): the stations are cards in the
 *   page's flow over the tree, which turns as you pass them (and holds still
 *   under reduced motion).
 *
 * Everything that moves is written straight to the DOM in one rAF loop; React
 * renders the markup once. The 3D (engine.ts) is fetched after the poster has
 * painted and fades in over it; until then, and wherever it cannot run, the
 * poster is the picture.
 */

const STATION_ANCHOR = (i: number, u: number): V3 => {
  switch (i) {
    case 0:
      return rowPoint(FEATURED.row);
    case 1:
      return boughAt(FEATURED, 0.04);
    case 2:
      return boughAt(FEATURED, Math.max(0.05, stateAt(FEATURED, u).progress));
    case 3:
      return boughAt(FEATURED, 1);
    default:
      return CROWN;
  }
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => ease(clamp01((x - a) / (b - a)));

/** How present station i is at scroll s (0..1). */
function presence(i: number, s: number) {
  const at = STATIONS_S[i] ?? 0;
  return smooth(at - 0.3, at - 0.08, s) * (1 - smooth(at + 0.56, at + 0.8, s));
}

function canRender(): boolean {
  if ("gpu" in navigator) return true;
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function TreeSequence() {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const panes = useRef<(HTMLElement | null)[]>([]);
  const captions = useRef<(HTMLElement | null)[]>([]);
  const leaders = useRef<(SVGGElement | null)[]>([]);
  const rail = useRef<(HTMLElement | null)[]>([]);
  const cards = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    const sec = section.current;
    const stg = stage.current;
    const cvs = canvas.current;
    const ov = overlay.current;
    if (!sec || !stg || !cvs || !ov) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wideQ = window.matchMedia("(min-width: 1000px)");
    let pin = root.classList.contains("pin");
    let wide = wideQ.matches;
    let ks = keys(pin, wide, stg.clientWidth / stg.clientHeight);
    let W = stg.clientWidth;
    let H = stg.clientHeight;

    // ——— the DOM that rides on the scene: one plain word per lit ticket, set at its light ———
    const labels = ALL.map((b) => {
      const n = el("div", "tree-label");
      const word = el("span", "tree-label-word");
      n.append(word);
      ov.append(n);
      return { b, n, word, key: "" };
    });

    // ——— scroll → s (viewport heights from the top of the sequence) ———
    let secTop = 0;
    let cardYs: number[] = [];
    let paneBox: { left: number; top: number; h: number }[] = [];
    const measure = () => {
      W = stg.clientWidth;
      H = stg.clientHeight;
      secTop = sec.getBoundingClientRect().top + window.scrollY;
      cardYs = cards.current.map((c) => {
        if (!c) return 0;
        const r = c.getBoundingClientRect();
        return r.top + window.scrollY + r.height / 2 - H / 2;
      });
      // Untransformed boxes: offset* ignore the per-frame transforms.
      paneBox = panes.current.map((p) =>
        p
          ? { left: p.offsetLeft, top: p.offsetTop - p.offsetHeight / 2, h: p.offsetHeight }
          : { left: 0, top: 0, h: 0 },
      );
    };
    const targetS = () => {
      const y = window.scrollY - secTop;
      if (pin) return Math.min(END_S, Math.max(0, y / H));
      // list: the hero's own height leads to the first card, then card to card.
      const ys = [0, ...cardYs.map((c) => c - secTop)];
      const ss = [0, ...STATIONS_S];
      for (let i = 1; i < ys.length; i++) {
        if (y <= ys[i]!) {
          return (
            ss[i - 1]! +
            ((y - ys[i - 1]!) / Math.max(1, ys[i]! - ys[i - 1]!)) * (ss[i]! - ss[i - 1]!)
          );
        }
      }
      const y0 = ys[ys.length - 1]!;
      return Math.min(END_S, ss[ss.length - 1]! + ((y - y0) / H) * (END_S - ss[ss.length - 1]!));
    };

    // ——— the engine ———
    let engine: Engine | null = null;
    let disposed = false;
    const resize = () => {
      measure();
      ks = keys(pin, wide, W / H);
      engine?.resize(W, H);
      if (reduced) draw(performance.now());
    };
    const fail = () => {
      stg.dataset.live = "none";
      if (pin) {
        pin = false;
        root.classList.remove("pin");
        ks = keys(false, wide, W / H);
        measure();
      }
    };
    const load = async () => {
      if (!canRender()) return fail();
      try {
        const { createEngine } = await import("./engine");
        if (disposed) return;
        const lite = !wide || (navigator.hardwareConcurrency ?? 8) <= 4;
        const e = await createEngine(cvs, { lite });
        if (disposed) return e.dispose();
        engine = e;
        e.resize(W, H);
        draw(performance.now());
        stg.dataset.live = e.backend;
      } catch (err) {
        console.warn("santree: the 3D tree could not start; the poster stays.", err);
        fail();
      }
    };

    // ——— the frame ———
    let t = 0;
    let s = 0;
    let last = performance.now();
    let pose: Pose = heroPose(wide);

    function draw(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduced) t += dt;
      const sT = reduced ? 0 : targetS();
      s = reduced ? 0 : s + (sT - s) * (1 - Math.exp(-dt * 7));
      if (Math.abs(sT - s) < 1e-4) s = sT;
      pose = poseAt(ks, s, t, reduced);
      const featured = featuredAt(s, t);
      const focus = smooth(0.25, 0.9, s) * (1 - smooth(END_S - 0.55, END_S, s));
      engine?.render({ pose, t, featured, focus, mark: markAt(s) });

      const v = viewOf(pose, W / H);
      const toPx = (p: V3) => {
        const q = project(v, p);
        return { x: (q.x * 0.5 + 0.5) * W, y: (0.5 - q.y * 0.5) * H };
      };
      const stOf = (b: (typeof ALL)[number]) =>
        b === FEATURED ? stateAt(b, featured.u) : stateAt(b, t + b.offset);

      // Labels: one plain word per lit ticket, set beside its light, in the hero, on wide screens.
      const heroS = reduced ? Math.max(0, (window.scrollY - secTop) / H) : s;
      const heroA = wide ? 1 - smooth(0.05, 0.4, heroS) : 0;
      const placed: { L: (typeof labels)[number]; x: number; y: number; right: boolean }[] = [];
      for (const L of labels) {
        const st = stOf(L.b);
        const shown = st.stage === "work" || st.stage === "pr" || st.stage === "merged";
        L.n.style.opacity = String(shown ? heroA * (L.b === FEATURED ? featured.alpha : 1) : 0);
        if (!shown) continue;
        const key = st.dot;
        if (key !== L.key) {
          L.key = key;
          L.word.textContent = DOT_WORD[st.dot];
          L.word.style.color = DOT_COLOR[st.dot];
        }
        const at: V3 =
          st.stage === "work" ? boughAt(L.b, Math.max(0.05, st.progress)) : boughAt(L.b, 1);
        const p = toPx(swayP(at, t));
        placed.push({ L, x: p.x, y: p.y, right: p.x > toPx([0, at[1], 0]).x });
      }
      // Never on top of each other: on each side, push apart top to bottom.
      for (const side of [true, false]) {
        const col = placed.filter((q) => q.right === side).sort((a, b) => a.y - b.y);
        for (let i = 1; i < col.length; i++) {
          const prev = col[i - 1];
          const cur = col[i];
          if (prev && cur) cur.y = Math.max(cur.y, prev.y + 26);
        }
      }
      for (const q of placed) {
        q.L.n.style.transform = q.right
          ? `translate3d(${q.x + 14}px, ${q.y}px, 0) translateY(-50%)`
          : `translate3d(${q.x - 14}px, ${q.y}px, 0) translate(-100%, -50%)`;
        q.L.n.dataset.side = q.right ? "r" : "l";
      }

      // The panes and their leaders (pin); in the list layout the cards are in the flow.
      if (pin) {
        let active = -1;
        let best = 0;
        STATIONS.forEach((_, i) => {
          const o = presence(i, s);
          if (o > best) {
            best = o;
            active = i;
          }
          const pane = panes.current[i];
          const cap = captions.current[i];
          const lead = leaders.current[i];
          if (!pane || !cap || !lead) return;
          const vis = o > 0.002;
          pane.style.visibility = vis ? "visible" : "hidden";
          cap.style.visibility = vis ? "visible" : "hidden";
          lead.style.visibility = vis ? "visible" : "hidden";
          if (!vis) return;
          const a = toPx(swayP(STATION_ANCHOR(i, featured.u), t));
          const rise = (1 - o) * 14;
          const drift = 0;
          pane.style.opacity = String(o);
          pane.style.transform = `translate3d(0, calc(-50% + ${rise}px), 0)`;
          cap.style.opacity = String(o);
          cap.style.transform = `translate3d(0, ${rise * 0.6}px, 0)`;
          // The leader: from the 3D point to the pane's near edge.
          const box = paneBox[i] ?? { left: W * 0.5, top: H * 0.25, h: H * 0.5 };
          const top = box.top + drift + rise;
          const ex = box.left - 1;
          const ey = Math.min(Math.max(a.y, top + 40), top + box.h - 40);
          const line = lead.children[0] as SVGLineElement | undefined;
          line?.setAttribute("x1", String(a.x + 10));
          line?.setAttribute("y1", String(a.y));
          line?.setAttribute("x2", String(a.x + 10 + (ex - a.x - 10) * o));
          line?.setAttribute("y2", String(a.y + (ey - a.y) * o));
          for (const c of [lead.children[1], lead.children[2]]) {
            c?.setAttribute("cx", String(a.x));
            c?.setAttribute("cy", String(a.y));
          }
          const end = lead.children[3];
          end?.setAttribute("cx", String(ex));
          end?.setAttribute("cy", String(ey));
          lead.style.opacity = String(o);
        });
        rail.current.forEach((r, i) => {
          r?.classList.toggle("is-on", i === active && best > 0.5);
          r?.classList.toggle("is-past", i < active);
        });
        rail.current[0]?.parentElement?.style.setProperty("--rail-o", String(best));
      }
    }

    // ——— run only while the stage is on screen ———
    let raf = 0;
    let onScreen = true;
    const loop = (now: number) => {
      draw(now);
      raf = onScreen && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const kick = () => {
      if (reduced) return draw(performance.now());
      if (!raf && onScreen && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    const io = new IntersectionObserver((es) => {
      onScreen = !!es.at(-1)?.isIntersecting;
      kick();
    });
    io.observe(sec);
    const ro = new ResizeObserver(() => resize());
    ro.observe(stg);
    const onWide = () => {
      wide = wideQ.matches;
      pin = root.classList.contains("pin");
      ks = keys(pin, wide, W / H);
      resize();
    };
    wideQ.addEventListener("change", onWide);
    document.addEventListener("visibilitychange", kick);
    if (reduced) window.addEventListener("scroll", kick, { passive: true });

    measure();
    kick();
    // Fetch the 3D once the poster is on screen and the main thread is free.
    const idle = (
      window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    ).requestIdleCallback;
    const handle = idle
      ? idle(() => void load(), { timeout: 1200 })
      : window.setTimeout(() => void load(), 300);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      wideQ.removeEventListener("change", onWide);
      document.removeEventListener("visibilitychange", kick);
      window.removeEventListener("scroll", kick);
      if (!idle) window.clearTimeout(handle);
      engine?.dispose();
      for (const L of labels) L.n.remove();
    };
  }, []);

  return (
    <section ref={section} className="seq relative" aria-label="santree, from ticket to merge">
      <div ref={stage} className="stage sticky top-0 h-svh w-full overflow-hidden">
        <TreePoster className="poster absolute inset-0 size-full" />
        <canvas ref={canvas} className="stage-canvas absolute inset-0 size-full" aria-hidden />
        <div className="stage-shade absolute inset-0" aria-hidden />
        <div
          ref={overlay}
          className="stage-overlay pointer-events-none absolute inset-0"
          aria-hidden
        >
          <svg className="pin-only absolute inset-0 size-full overflow-visible" aria-hidden>
            {STATIONS.map((st, i) => (
              <g
                key={st.id}
                ref={(g) => {
                  leaders.current[i] = g;
                }}
                style={{ visibility: "hidden" }}
              >
                <line stroke="rgba(233,241,237,0.34)" strokeWidth={1} />
                <circle r={5.5} fill="none" stroke="rgba(233,241,237,0.5)" strokeWidth={1} />
                <circle r={1.8} fill="#e9f1ed" />
                <circle r={1.8} fill="rgba(233,241,237,0.7)" />
              </g>
            ))}
          </svg>
        </div>
        <div className="pin-only">
          <div className="seq-rail" aria-hidden>
            {STATIONS.map((st, i) => (
              <span
                key={st.id}
                ref={(r) => {
                  rail.current[i] = r;
                }}
              >
                {st.name}
              </span>
            ))}
          </div>
          {STATIONS.map((st, i) => (
            <div key={st.id}>
              <div
                className="seq-caption"
                ref={(c) => {
                  captions.current[i] = c;
                }}
                style={{ visibility: "hidden" }}
              >
                <h2 className="font-display t-title">{st.title}</h2>
                <p className="t-body">{st.body}</p>
              </div>
              <figure
                className="seq-pane"
                ref={(p) => {
                  panes.current[i] = p;
                }}
                style={{ visibility: "hidden", ["--ar" as string]: cropAspect(st.crop) }}
              >
                <Capture screen={st.screen} crop={st.crop} alt={st.alt} />
                {st.id === "run" && <PromptCard className="seq-prompt" />}
                {st.id === "steer" && AGENT_LAYER_SHIPPED && <LayerCard className="seq-layer" />}
              </figure>
            </div>
          ))}
        </div>
      </div>

      <div className="relative -mt-[100svh]">
        <Hero />
        <div id="how">
          <div className="pin-only" style={{ height: `${END_S * 100}svh` }} aria-hidden />
          <ol className="list-only seq-list">
            {STATIONS.map((st, i) => (
              <li
                key={st.id}
                ref={(c) => {
                  cards.current[i] = c;
                }}
                className="seq-card"
              >
                <p className="seq-card-name t-label">{st.name}</p>
                <h2 className="font-display t-title">{st.title}</h2>
                <p className="seq-card-body t-body">{st.body}</p>
                {st.id === "run" && <PromptCard className="seq-prompt-flow" />}
                {st.id === "steer" && AGENT_LAYER_SHIPPED && <LayerCard className="seq-layer-flow" />}
                <Capture screen={st.screen} crop={st.list} alt={st.alt} />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/** A capture cut to the part of the app a station is about: sharp at the size it is shown. */
function Capture({
  screen,
  crop,
  alt,
}: {
  screen: Parameters<typeof screenSrc>[0];
  crop: Crop;
  alt: string;
}) {
  return (
    <div className="crop" style={{ aspectRatio: String(cropAspect(crop)) }}>
      <img
        src={screenSrc(screen)}
        alt={alt}
        width={SCREEN_W}
        height={SCREEN_H}
        loading="lazy"
        decoding="async"
        style={{
          width: `${100 / crop.w}%`,
          left: `${(-crop.x / crop.w) * 100}%`,
          top: `${(-crop.y / crop.h) * 100}%`,
        }}
      />
    </div>
  );
}

/** The ticket's opening prompt, as santree renders it from the ticket. Nobody typed it. */
function PromptCard({ className }: { className?: string }) {
  return (
    <div className={className}>
      <p className="seq-prompt-head">
        <span>{PROMPT.file}</span>
        <span>written from the ticket</span>
      </p>
      <pre>
        {PROMPT.lines.map((l, i) => (
          <span key={i} className={l.k ? `pl-${l.k}` : undefined}>
            {l.t}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** What santree adds to a session: a redraw in the app's colors (agent-layer.ts says what is real). */
function LayerCard({ className }: { className?: string }) {
  const dot = { done: "#3fb950", doing: "#d29922", todo: "#6e7681" } as const;
  return (
    <div className={`layer ${className ?? ""}`}>
      <p className="seq-prompt-head">
        <span>{LAYER.head}</span>
      </p>
      <div className="layer-sec">
        <p className="layer-label">{LAYER.progress.label}</p>
        <ul>
          {LAYER.progress.items.map((it) => (
            <li key={it.t} data-s={it.s}>
              <i style={{ background: dot[it.s] }} aria-hidden />
              {it.t}
            </li>
          ))}
        </ul>
      </div>
      <div className="layer-sec">
        <p className="layer-label">{LAYER.question.label}</p>
        <p className="layer-q">{LAYER.question.text}</p>
        <div className="layer-btns">
          <span className="is-primary">{LAYER.question.yes}</span>
          <span>{LAYER.question.no}</span>
        </div>
      </div>
      <div className="layer-sec">
        <p className="layer-label">{LAYER.plan.label}</p>
        <ol>
          {LAYER.plan.steps.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="hero relative flex h-svh flex-col">
      <div className="mx-auto flex w-full max-w-[1360px] flex-1 flex-col justify-end px-6 pb-[12svh] sm:px-10 min-[1000px]:justify-center min-[1000px]:pb-0 lg:px-14">
        <h1 className="hero-title font-display">
          The ticket is the prompt.
          <span className="hero-title-2"> Tickets in, pull requests out.</span>
        </h1>
        <p className="hero-sub t-lede">
          Press Run on a ticket and santree writes the first prompt from it (the description, the
          comments and your notes), then starts an agent in a worktree of its own.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <DownloadButton size="lg" />
          <a href="https://github.com/santree-ai/santree" className="btn btn-ghost h-11 px-5">
            <GitHubLogo size={15} />
            Source
          </a>
        </div>
      </div>
      <a href="#how" className="hero-cue t-label">
        <span className="hero-cue-line" aria-hidden />
        Scroll
      </a>
    </div>
  );
}
