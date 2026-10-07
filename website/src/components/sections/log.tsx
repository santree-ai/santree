/** "How it works", drawn as the thing santree actually produces: a git graph.
 * One main branch, three worktrees forking off it, their agents working in
 * parallel, and each branch merging back. The loop's stages annotate the log
 * where they happen instead of sitting in a row of cards.
 *
 * Each row draws its own slice of the graph, like `git log --graph` does, so
 * the lanes stay continuous at any row height. The rows reveal on a CSS view
 * timeline (styles.css, `.log-row`): pure CSS, so it runs pre-hydration, and
 * a browser without scroll-driven animations, or a reader with reduced motion,
 * gets the whole graph drawn.
 *
 * The story is the screenshot fixture world (Mallard Labs, QuackStack), so
 * the tickets match the hero's captures. The state words and colors are the
 * app's own (`sessionStateMeta` in the app's src/theme/colors.ts): resync if
 * those change. */

type Tone = "running" | "delegating" | "permission" | "idle" | "failed" | "merged" | "main";

const TONE: Record<Tone, string> = {
  running: "#3fb950",
  delegating: "#4493f8",
  permission: "#f85149",
  idle: "#d29922",
  failed: "#f85149",
  merged: "#a78bfa",
  main: "#2dd4a7",
};

type Row =
  | { kind: "stage"; title: string; body: string }
  | {
      kind: "commit" | "fork" | "merge";
      lane: number;
      tone: Tone;
      /** Hidden below `sm`, so a phone keeps the part that differs. */
      pre?: string;
      msg: string;
      meta: string;
    };

const ROWS: Row[] = [
  {
    kind: "stage",
    title: "Triage",
    body: "Tickets come in from Linear or Jira. The triage queue keeps its rotation and SLA clock in the sidebar, and an agent can start reading one on the main checkout before anything branches.",
  },
  {
    kind: "commit",
    lane: 0,
    tone: "delegating",
    msg: "QK-203 Bread dispenser 500s at a zero budget",
    meta: "triage · Codex investigating on main · SLA in 1h",
  },
  {
    kind: "stage",
    title: "Branch",
    body: "Run gives each ready ticket its own git worktree with an agent inside it. Select the ready ones, launch, and they start together.",
  },
  {
    kind: "fork",
    lane: 1,
    tone: "running",
    pre: "worktree add ",
    msg: ".santree/worktrees/QK-142",
    meta: "Claude Code · Ducks render upside down in Safari",
  },
  {
    kind: "fork",
    lane: 2,
    tone: "running",
    pre: "worktree add ",
    msg: ".santree/worktrees/QK-138",
    meta: "Claude Code · Migrate quack events to pond_v2",
  },
  {
    kind: "fork",
    lane: 3,
    tone: "running",
    pre: "worktree add ",
    msg: ".santree/worktrees/QK-127",
    meta: "Codex · Pond dashboard: dark mode",
  },
  {
    kind: "stage",
    title: "Steer",
    body: "Every agent runs in a real terminal you can type into. The dot beside each tree in the sidebar says which one is working and which one is waiting on you.",
  },
  {
    kind: "commit",
    lane: 1,
    tone: "running",
    msg: "Read src/pond/DuckLayer.tsx",
    meta: "QK-142 · running",
  },
  {
    kind: "commit",
    lane: 2,
    tone: "permission",
    msg: "Bash(pnpm db:migrate --dry-run)",
    meta: "QK-138 · needs permission",
  },
  {
    kind: "commit",
    lane: 3,
    tone: "delegating",
    msg: "Task: audit the pond theme tokens",
    meta: "QK-127 · running a subagent",
  },
  {
    kind: "commit",
    lane: 1,
    tone: "idle",
    msg: "fix(pond): keep westward ducks upright",
    meta: "QK-142 · +11 −1 · 7 tests passed",
  },
  {
    kind: "stage",
    title: "Review",
    body: "Open the PR from the worktree. A red check or a reviewer's comment lands in that PR's work queue, and Start work hands the queue back to the agent.",
  },
  {
    kind: "commit",
    lane: 2,
    tone: "failed",
    msg: "✕ unit (2/3) · 1 review comment",
    meta: "QK-138 · into the work queue",
  },
  {
    kind: "commit",
    lane: 2,
    tone: "running",
    msg: "fix(pond_v2): batch the backfill",
    meta: "QK-138 · Start work",
  },
  {
    kind: "stage",
    title: "Ship",
    body: "Merge it and delete the tree. Your own checkout never moved.",
  },
  {
    kind: "merge",
    lane: 1,
    tone: "merged",
    pre: "merge ",
    msg: "sam/qk-142-ducks-render-upside-down",
    meta: "PR merged · tree deleted",
  },
  {
    kind: "merge",
    lane: 2,
    tone: "merged",
    pre: "merge ",
    msg: "sam/qk-138-migrate-quack-events",
    meta: "PR merged · tree deleted",
  },
  {
    kind: "merge",
    lane: 3,
    tone: "merged",
    pre: "merge ",
    msg: "sam/qk-127-pond-dashboard-dark-mode",
    meta: "PR merged · tree deleted",
  },
  {
    kind: "commit",
    lane: 0,
    tone: "main",
    msg: "main",
    meta: "three PRs merged · QK-203 still in triage",
  },
];

/* Graph geometry, in px. Commit rows have a fixed height so fork and merge
 * curves can be drawn exactly; stage rows stretch, so they only carry
 * straight lanes, drawn in percentages. */
const LANES = 4;
const GAP = 22;
const X0 = 11;
const ROW_H = 56;
const NODE_Y = 22;
const GRAPH_W = X0 * 2 + GAP * (LANES - 1);
const lx = (lane: number) => X0 + lane * GAP;

const MAIN = "rgba(45, 212, 167, 0.55)";
const BRANCH = "rgba(255, 255, 255, 0.2)";
const laneStroke = (lane: number) => (lane === 0 ? MAIN : BRANCH);

/** Which lanes are open entering each row, derived from the forks and merges
 * so the data above stays a plain story. */
function openLanesBefore(rows: Row[]): Set<number>[] {
  const open = new Set<number>([0]);
  return rows.map((row) => {
    const before = new Set(open);
    if (row.kind === "fork") open.add(row.lane);
    if (row.kind === "merge") open.delete(row.lane);
    return before;
  });
}

function Lane({ lane, y1, y2 }: { lane: number; y1: number | string; y2: number | string }) {
  return (
    <line
      className="log-lane"
      pathLength={1}
      x1={lx(lane)}
      x2={lx(lane)}
      y1={y1}
      y2={y2}
      stroke={laneStroke(lane)}
      strokeWidth={lane === 0 ? 1.6 : 1.2}
    />
  );
}

function StageGraph({ open }: { open: Set<number> }) {
  return (
    <svg width={GRAPH_W} className="absolute inset-y-0 left-0 h-full overflow-visible" aria-hidden>
      {[...open].map((lane) => (
        <Lane key={lane} lane={lane} y1="0%" y2="100%" />
      ))}
    </svg>
  );
}

function CommitGraph({ row, open }: { row: Extract<Row, { lane: number }>; open: Set<number> }) {
  const { lane, kind, tone } = row;
  const color = TONE[tone];
  const node = kind === "merge" ? 0 : lane;
  const lanes = [...open].filter((l) => {
    if (kind === "fork" && l === lane) return false;
    if (kind === "merge" && l === lane) return false;
    return true;
  });
  const glow = tone === "permission";

  return (
    <svg
      width={GRAPH_W}
      height={ROW_H}
      viewBox={`0 0 ${GRAPH_W} ${ROW_H}`}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {lanes.map((l) => (
        <Lane key={l} lane={l} y1={0} y2={ROW_H} />
      ))}
      {kind === "fork" ? (
        <>
          <path
            className="log-lane"
            pathLength={1}
            d={`M${lx(0)} 0 C${lx(0)} ${NODE_Y * 0.7} ${lx(lane)} ${NODE_Y * 0.3} ${lx(lane)} ${NODE_Y}`}
            fill="none"
            stroke={BRANCH}
            strokeWidth={1.2}
          />
          <Lane lane={lane} y1={NODE_Y} y2={ROW_H} />
        </>
      ) : null}
      {kind === "merge" ? (
        <path
          className="log-lane"
          pathLength={1}
          d={`M${lx(lane)} 0 C${lx(lane)} ${NODE_Y * 0.7} ${lx(0)} ${NODE_Y * 0.3} ${lx(0)} ${NODE_Y}`}
          fill="none"
          stroke={BRANCH}
          strokeWidth={1.2}
        />
      ) : null}
      {glow ? <circle className="log-pulse" cx={lx(node)} cy={NODE_Y} r={9} fill={color} /> : null}
      <circle
        className="log-node"
        cx={lx(node)}
        cy={NODE_Y}
        r={kind === "merge" || tone === "main" ? 4.5 : 3.75}
        fill={kind === "fork" ? "#07080a" : color}
        stroke={color}
        strokeWidth={kind === "fork" ? 1.5 : 0}
      />
    </svg>
  );
}

const LEGEND: { tone: Tone; label: string }[] = [
  { tone: "running", label: "running" },
  { tone: "delegating", label: "running a subagent" },
  { tone: "permission", label: "needs you" },
  { tone: "idle", label: "turn finished" },
  { tone: "merged", label: "merged" },
];

export function Log() {
  const open = openLanesBefore(ROWS);

  return (
    <section id="loop" className="scroll-mt-20 pb-28 pt-12 sm:pb-36 sm:pt-16">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-14 px-6 lg:grid-cols-[5fr_7fr] lg:gap-20">
        <div className="lg:sticky lg:top-32 lg:self-start">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
            How it works
          </p>
          <h2 className="mt-4 text-balance text-[clamp(2rem,1.4rem+2.4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.02em]">
            One loop, run in <span className="text-accent">parallel.</span>
          </h2>
          <p className="mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-muted">
            A morning on one repo, drawn the way git records it: three tickets, three worktrees, one
            main branch that nobody had to stash.
          </p>
          <ul className="mt-8 flex max-w-md flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] text-muted-2">
            {LEGEND.map((l) => (
              <li key={l.tone} className="flex items-center gap-2">
                <span className="size-1.5 rounded-full" style={{ background: TONE[l.tone] }} />
                {l.label}
              </li>
            ))}
          </ul>
        </div>

        <ol className="log min-w-0" aria-label="A git graph of three tickets worked in parallel">
          {ROWS.map((row, i) => {
            const before = open[i] ?? new Set<number>();
            if (row.kind === "stage") {
              return (
                <li key={row.title} className="log-row relative">
                  <StageGraph open={before} />
                  <div className="log-stage ml-[104px] py-7 sm:ml-[112px] sm:py-9">
                    <h3 className="text-[17px] font-medium tracking-[-0.01em]">{row.title}</h3>
                    <p className="mt-2 max-w-md text-pretty text-[14px] leading-relaxed text-muted">
                      {row.body}
                    </p>
                  </div>
                </li>
              );
            }
            return (
              <li
                key={`${row.kind}-${row.lane}-${row.msg}`}
                className="log-row flex items-start gap-4 sm:gap-6"
                style={{ height: ROW_H }}
              >
                <CommitGraph row={row} open={before} />
                <div className="min-w-0 pt-[13px]">
                  <p className="truncate font-mono text-[11.5px] leading-[18px] text-fg sm:text-[12.5px]">
                    {row.pre ? <span className="hidden sm:inline">{row.pre}</span> : null}
                    {row.msg}
                  </p>
                  <p className="truncate font-mono text-[11px] leading-[16px] text-muted-2">
                    {row.meta}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
