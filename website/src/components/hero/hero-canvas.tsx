import { useEffect, useRef } from "react";

/** The hero's generative background: a quiet field of santree's own
 * exhaust — branch names, tool calls, diffstats — written out character by
 * character along slow curved paths, snapped to a character grid, decaying
 * like phosphor. Ambient texture first: dim, dense, desaturated emerald;
 * the pointer lifts nearby glyphs a little. No hard shapes, no lines.
 *
 * Everything happens in one effect (SSR renders a bare canvas). Guards:
 * dpr capped at 2, particle count scaled by area, 30Hz sim under a rAF
 * draw, IntersectionObserver + visibilitychange pause, no per-frame
 * allocation. Reduced motion: the sim is run forward once and drawn as a
 * single static frame. */

const CELL = 13;
const FONT = `11px "Geist Mono Variable", ui-monospace, monospace`;
const SIM_MS = 1000 / 30;
const TRAIL_DECAY = 0.9945;
const MOUSE_R = 130;

// Dim desaturated emerald for the body; heads lean toward the accent.
const BODY = [158, 196, 182] as const;
const HEAD = [96, 224, 183] as const;

const STRINGS = [
  "git worktree add .santree/worktrees/san-142",
  "⏺ Read src/auth/refresh.ts",
  "santree/san-142-oauth-refresh",
  "+186 −44 · 4 files",
  "SAN-138 webhook retries duplicate on 429",
  "⏺ Edit src/session/restore.ts",
  "pnpm test auth · 14 passed",
  'git commit -m "serialize refresh"',
  "SAN-151 idempotency keys for deliveries",
  "gh pr create --fill",
  '⏺ Grep "refresh_token" src/',
  "santree/san-127-session-restore",
  "✓ regression test for concurrent refresh",
  "SAN-160 ship session hardening",
  "git rebase origin/main",
  "codex · gpt-5.6 · 42% context",
  "claude code · opus · waiting on you",
] as const;

interface Particle {
  // Quadratic bezier path: A → (control C) → B, then a new path is rolled.
  ax: number;
  ay: number;
  cx: number;
  cy: number;
  bx: number;
  by: number;
  t: number;
  speed: number;
  text: string;
  charIndex: number;
  lastX: number;
  lastY: number;
}

interface Trail {
  x: number;
  y: number;
  char: string;
  alpha: number;
  head: number; // 1 = freshly written (accent-leaning), decays to body color
}

export function HeroCanvas({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    const trails = new Map<number, Trail>();
    let visible = true;
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const mouse = { x: -1e4, y: -1e4 };

    const rollPath = (p: Particle) => {
      // Gentle arcs that drift outward from the middle band — tree-ish
      // motion without drawing the tree.
      const side = Math.random() < 0.5 ? -1 : 1;
      p.ax = width * (0.5 + side * (0.05 + Math.random() * 0.42));
      p.ay = height * (0.08 + Math.random() * 0.8);
      p.bx = p.ax + side * width * (0.12 + Math.random() * 0.22);
      p.by = p.ay - height * (0.05 + Math.random() * 0.18) * (Math.random() < 0.3 ? -1 : 1);
      p.cx = (p.ax + p.bx) / 2 + side * 40;
      p.cy = Math.min(p.ay, p.by) - 20 - Math.random() * 40;
      p.t = 0;
      p.speed = 0.0011 + Math.random() * 0.0016;
      p.lastX = -1e4;
      p.lastY = -1e4;
    };

    const rebuild = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT;
      ctx.textBaseline = "middle";
      trails.clear();

      const count = Math.max(24, Math.min(64, Math.round((width * height) / 26000)));
      particles = [];
      for (let i = 0; i < count; i++) {
        const p: Particle = {
          ax: 0,
          ay: 0,
          cx: 0,
          cy: 0,
          bx: 0,
          by: 0,
          t: 0,
          speed: 0,
          text: STRINGS[i % STRINGS.length] ?? "",
          charIndex: Math.floor(Math.random() * 8),
          lastX: -1e4,
          lastY: -1e4,
        };
        rollPath(p);
        p.t = Math.random(); // scatter along their paths at boot
        particles.push(p);
      }
    };

    const step = () => {
      for (const tr of trails.values()) {
        tr.alpha *= TRAIL_DECAY;
        tr.head *= 0.94;
      }
      for (const p of particles) {
        p.t += p.speed * SIM_MS;
        if (p.t >= 1) {
          rollPath(p);
          continue;
        }
        const u = 1 - p.t;
        const x = u * u * p.ax + 2 * p.t * u * p.cx + p.t * p.t * p.bx;
        const y = u * u * p.ay + 2 * p.t * u * p.cy + p.t * p.t * p.by;
        if (Math.hypot(x - p.lastX, y - p.lastY) < CELL * 0.95) continue;
        p.lastX = x;
        p.lastY = y;
        const char = p.text[p.charIndex % p.text.length] ?? " ";
        p.charIndex += 1;
        if (char === " ") continue;
        const near = Math.hypot(x - mouse.x, y - mouse.y) < MOUSE_R;
        const gx = Math.round(x / CELL);
        const gy = Math.round(y / CELL);
        trails.set(gy * 4096 + gx, {
          x: gx * CELL,
          y: gy * CELL,
          char,
          alpha: near ? 0.34 : 0.15,
          head: 1,
        });
      }
      for (const [key, tr] of trails) {
        if (tr.alpha < 0.012) trails.delete(key);
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const tr of trails.values()) {
        const r = BODY[0] + (HEAD[0] - BODY[0]) * tr.head;
        const g = BODY[1] + (HEAD[1] - BODY[1]) * tr.head;
        const b = BODY[2] + (HEAD[2] - BODY[2]) * tr.head;
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${tr.alpha.toFixed(3)})`;
        ctx.fillText(tr.char, tr.x, tr.y);
      }
    };

    rebuild();

    if (reduced) {
      for (let i = 0; i < 900; i++) step();
      draw();
      canvas.style.opacity = "1";
      const ro = new ResizeObserver(() => {
        rebuild();
        for (let i = 0; i < 900; i++) step();
        draw();
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || width === 0) {
        last = now;
        return;
      }
      acc += Math.min(now - last, 200);
      last = now;
      while (acc >= SIM_MS) {
        acc -= SIM_MS;
        step();
      }
      draw();
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    io.observe(canvas);
    const ro = new ResizeObserver(rebuild);
    ro.observe(canvas);
    const onPointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      mouse.x = -1e4;
      mouse.y = -1e4;
    };
    // Listen on window: the canvas sits behind the hero text, which would
    // otherwise swallow pointer events.
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerout", onLeave);

    // Warm start so the first visible frame is already a settled field.
    for (let i = 0; i < 700; i++) step();
    raf = requestAnimationFrame(loop);
    canvas.style.opacity = "1";

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerout", onLeave);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={className}
      style={{ opacity: 0, transition: "opacity 1.2s ease" }}
    />
  );
}
