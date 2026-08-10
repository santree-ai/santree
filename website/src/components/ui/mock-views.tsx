/** Designed low-fi mock UIs for the four views — intentional compositions,
 * not generic skeletons, shown until real screenshots exist. Pure SVG on a
 * 640×400 canvas, text-free, tinted with the app's status colors. */

const INK = {
  bar: "#1e1f24",
  barSoft: "#191a1f",
  line: "rgba(255,255,255,0.06)",
  panel: "rgba(255,255,255,0.015)",
  accent: "#2dd4a7",
  blue: "#4493f8",
  amber: "#d29922",
  red: "#f85149",
  purple: "#a78bfa",
  green: "#3fb950",
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 640 400"
      preserveAspectRatio="xMidYMid slice"
      className="size-full"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Triage: a keyboard-driven queue — priority dots, one row focused. */
export function MockTriage() {
  const rows = [
    { y: 64, w: 210, dot: INK.red },
    { y: 104, w: 250, dot: INK.amber, focus: true },
    { y: 144, w: 190, dot: INK.amber },
    { y: 184, w: 235, dot: INK.blue },
    { y: 224, w: 205, dot: INK.blue },
    { y: 264, w: 225, dot: INK.purple },
    { y: 304, w: 180, dot: INK.purple },
  ];
  return (
    <Frame>
      <line x1="360" y1="0" x2="360" y2="400" stroke={INK.line} />
      <rect x="28" y="26" width="120" height="9" rx="4.5" fill={INK.bar} />
      {rows.map((r) => (
        <g key={r.y}>
          {r.focus && (
            <rect
              x="16"
              y={r.y - 13}
              width="330"
              height="34"
              rx="8"
              fill="rgba(45,212,167,0.05)"
              stroke="rgba(45,212,167,0.35)"
            />
          )}
          <circle cx="36" cy={r.y + 4} r="3.5" fill={r.dot} opacity="0.85" />
          <rect x="52" y={r.y} width={r.w} height="8" rx="4" fill={r.focus ? "#2a2b31" : INK.bar} />
        </g>
      ))}
      {/* detail panel */}
      <rect x="384" y="26" width="160" height="11" rx="5.5" fill="#26272d" />
      <rect
        x="384"
        y="56"
        width="70"
        height="18"
        rx="9"
        fill="rgba(68,147,248,0.15)"
        stroke="rgba(68,147,248,0.4)"
      />
      <rect
        x="464"
        y="56"
        width="70"
        height="18"
        rx="9"
        fill="rgba(255,255,255,0.04)"
        stroke={INK.line}
      />
      <rect x="384" y="100" width="224" height="7" rx="3.5" fill={INK.barSoft} />
      <rect x="384" y="120" width="200" height="7" rx="3.5" fill={INK.barSoft} />
      <rect x="384" y="140" width="216" height="7" rx="3.5" fill={INK.barSoft} />
      <rect x="384" y="160" width="150" height="7" rx="3.5" fill={INK.barSoft} />
      <rect
        x="384"
        y="330"
        width="130"
        height="30"
        rx="8"
        fill="rgba(45,212,167,0.12)"
        stroke="rgba(45,212,167,0.45)"
      />
    </Frame>
  );
}

/** Issues: the dependency DAG — status-colored nodes, one running. */
export function MockIssues() {
  const edges: Array<[number, number, number, number]> = [
    [120, 90, 250, 160],
    [120, 230, 250, 160],
    [250, 160, 400, 100],
    [250, 160, 400, 230],
    [400, 100, 530, 160],
    [400, 230, 530, 160],
    [120, 330, 400, 230],
  ];
  return (
    <Frame>
      {edges.map(([x1, y1, x2, y2]) => (
        <path
          key={`${x1}-${y1}-${x2}`}
          d={`M${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
          fill="none"
          stroke={INK.line}
          strokeWidth="1.5"
        />
      ))}
      <Node x={120} y={90} color={INK.green} />
      <Node x={120} y={230} color={INK.green} />
      <Node x={120} y={330} color={INK.blue} />
      <Node x={250} y={160} color={INK.accent} glow />
      <Node x={400} y={100} color={INK.amber} />
      <Node x={400} y={230} color={INK.purple} />
      <Node x={530} y={160} color="#6e7681" />
    </Frame>
  );
}

function Node({ x, y, color, glow }: { x: number; y: number; color: string; glow?: boolean }) {
  return (
    <g>
      {glow && <circle cx={x} cy={y} r="26" fill={color} opacity="0.12" />}
      <rect
        x={x - 44}
        y={y - 17}
        width="88"
        height="34"
        rx="9"
        fill="rgba(255,255,255,0.025)"
        stroke={glow ? color : INK.line}
        strokeOpacity={glow ? 0.6 : 1}
      />
      <circle cx={x - 28} cy={y} r="3.5" fill={color} opacity="0.9" />
      <rect x={x - 16} y={y - 4} width="46" height="8" rx="4" fill={INK.bar} />
    </g>
  );
}

/** Trees: sidebar of worktrees + an agent terminal mid-thought. */
export function MockTrees() {
  const prompt = [
    { y: 60, w: 180, c: "#3a3b42" },
    { y: 84, w: 260, c: "#2c2d33" },
    { y: 108, w: 220, c: "#2c2d33" },
    { y: 148, w: 150, c: "rgba(45,212,167,0.5)" },
    { y: 172, w: 240, c: "#2c2d33" },
    { y: 196, w: 205, c: "#2c2d33" },
    { y: 236, w: 120, c: "rgba(45,212,167,0.5)" },
  ];
  return (
    <Frame>
      <line x1="170" y1="0" x2="170" y2="400" stroke={INK.line} />
      {/* worktree list, one running */}
      {[
        { y: 48, color: INK.accent, on: true },
        { y: 92, color: INK.blue },
        { y: 136, color: INK.amber },
        { y: 180, color: "#6e7681" },
      ].map((w) => (
        <g key={w.y}>
          {w.on && (
            <rect x="12" y={w.y - 14} width="146" height="36" rx="8" fill="rgba(45,212,167,0.06)" />
          )}
          <circle cx="30" cy={w.y + 4} r="3" fill={w.color} />
          <rect x="44" y={w.y} width={w.on ? 96 : 82} height="8" rx="4" fill={INK.bar} />
        </g>
      ))}
      {/* terminal */}
      <rect x="192" y="28" width="424" height="344" rx="10" fill="#08090c" stroke={INK.line} />
      {prompt.map((l) => (
        <g key={l.y}>
          <rect x="214" y={l.y} width="8" height="9" rx="2" fill="rgba(45,212,167,0.55)" />
          <rect x="232" y={l.y} width={l.w} height="9" rx="4" fill={l.c} />
        </g>
      ))}
      {/* cursor block */}
      <rect x="214" y="272" width="9" height="14" rx="2" fill={INK.accent}>
        <animate attributeName="opacity" values="1;1;0;0" dur="1.2s" repeatCount="indefinite" />
      </rect>
    </Frame>
  );
}

/** Reviews: a diff with an AI comment pinned to a hunk. */
export function MockReviews() {
  const lines: Array<{ y: number; w: number; kind?: "add" | "del" }> = [
    { y: 48, w: 300 },
    { y: 72, w: 260 },
    { y: 96, w: 280, kind: "del" },
    { y: 120, w: 310, kind: "add" },
    { y: 144, w: 240, kind: "add" },
    { y: 168, w: 290 },
    { y: 192, w: 200 },
    { y: 216, w: 270, kind: "del" },
    { y: 240, w: 290, kind: "add" },
    { y: 264, w: 250 },
    { y: 288, w: 300 },
    { y: 312, w: 180 },
  ];
  return (
    <Frame>
      <line x1="64" y1="0" x2="64" y2="400" stroke={INK.line} />
      {lines.map((l) => (
        <g key={l.y}>
          {l.kind && (
            <rect
              x="66"
              y={l.y - 7}
              width="360"
              height="22"
              fill={l.kind === "add" ? "rgba(63,185,80,0.07)" : "rgba(248,81,73,0.06)"}
            />
          )}
          <rect x="28" y={l.y} width="18" height="8" rx="4" fill={INK.barSoft} />
          <rect
            x="86"
            y={l.y}
            width={l.w}
            height="8"
            rx="4"
            fill={l.kind === "add" ? "#274a35" : l.kind === "del" ? "#4a2b2b" : INK.bar}
          />
        </g>
      ))}
      {/* AI comment card */}
      <g>
        <rect
          x="446"
          y="106"
          width="166"
          height="112"
          rx="10"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(45,212,167,0.35)"
        />
        <circle cx="468" cy="130" r="8" fill="rgba(45,212,167,0.25)" />
        <rect x="484" y="126" width="70" height="8" rx="4" fill="#2a2b31" />
        <rect x="462" y="152" width="132" height="7" rx="3.5" fill={INK.barSoft} />
        <rect x="462" y="170" width="118" height="7" rx="3.5" fill={INK.barSoft} />
        <rect x="462" y="188" width="126" height="7" rx="3.5" fill={INK.barSoft} />
        <path d="M446 140 L426 130" stroke="rgba(45,212,167,0.35)" />
      </g>
    </Frame>
  );
}

export function MockView({ view }: { view: string }) {
  switch (view) {
    case "triage":
      return <MockTriage />;
    case "issues":
      return <MockIssues />;
    case "reviews":
      return <MockReviews />;
    default:
      return <MockTrees />;
  }
}
