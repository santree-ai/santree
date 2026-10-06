/**
 * The demo world's mutable half: worktrees, their files, commits and PRs, the
 * AI review's output, the work queue and the agents at work — everything a
 * click in the demo changes. In memory only, so reloading the page (⌘R)
 * resets the demo to its opening scene.
 *
 * The views read through query hooks with long stale times. A change the real
 * backend announces with an event is announced here with the same generated
 * event, so the app's own listeners do the refreshing; only what prod polls
 * instead (GitHub, session history) is refreshed directly (`refreshPolled`).
 */
import type { QueryClient } from "@tanstack/react-query";

import {
  type AgentKind,
  type AgentState,
  type ChangedFile,
  events,
  type FileStatus,
  type ReviewBrief,
  type ReviewDraft,
  type ReviewWorkItem,
  type TaskStatus,
  type WorktreeTab,
} from "../../../bindings";
import { queryKeys } from "../../../lib/queries";
import type { SourceFile } from "./code";
import { branchFor, DRIVER, PLATFORM, SEC, ticketSeed, worktreePath } from "./company";
import { diffOf } from "./diff";
import {
  HERO,
  HERO_REPO,
  HERO_V1,
  type HeroPr,
  heroBeatTimes,
  heroBrief,
  heroChecks,
  heroDrafts,
  heroFixChanges,
} from "./hero";
import { BRANCH } from "./prs";
import {
  aiReviewScript,
  isDone,
  queueRunScript,
  type Script,
  type Step,
  scriptFor,
} from "./screens";

// ── Refreshing the views ─────────────────────────────────────────────────────

let client: QueryClient | null = null;

export function attachQueryClient(c: QueryClient) {
  client = c;
}

/** The reads prod polls rather than announces: GitHub, and session history. */
type PolledKey =
  | "prDetailPrefix"
  | "prSummaryPrefix"
  | "reviewsPrefix"
  | "mergeQueuePrefix"
  | "worktreePrsPrefix"
  | "worktreeSessionsPrefix";

/**
 * Refetch reads that prod has no event for. Prod polls GitHub and session
 * history on a timer of minutes; the demo compresses those minutes into
 * seconds, so it has to say when they moved. Anything prod does announce goes
 * through its event instead (`events.*.emit`), never through here.
 *
 * `queryKeys` is read at call time, never at import: in demo mode the app's
 * `lib/queries` imports the bindings shim, which imports this module.
 */
export function refreshPolled(...keys: PolledKey[]) {
  if (!client) return;
  for (const key of keys) void client.invalidateQueries({ queryKey: queryKeys[key] });
}

/** A worktree's git state moved — its list row, status, commits — which prod
 *  announces app-wide with `worktreeBasesChanged`. `files` also sends the
 *  watcher's `worktreeChanged`, which is what refreshes open diffs and sources. */
export function worktreeMoved(repo: string, issueId: string, { files = false } = {}) {
  void events.worktreeBasesChanged.emit({ repo, issueIds: [issueId] });
  if (files) void events.worktreeChanged.emit({ issueId });
}

/** An agent's session row changed state, as the hook would announce it. */
function sessionsMoved() {
  void events.sessionStateChanged.emit({});
  refreshPolled("worktreeSessionsPrefix");
}

/** When the demo booted: every "n minutes ago" in the opening scene hangs off it. */
export const T0 = Date.now();

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Worktrees ────────────────────────────────────────────────────────────────

export interface WorkFile {
  path: string;
  status: FileStatus;
  staged: boolean;
  oldText: string;
  newText: string;
}

export interface WtState {
  id: string;
  repo: string;
  title: string;
  branch: string;
  baseBranch: string;
  status: TaskStatus | null;
  agent: AgentKind | null;
  setupRan: boolean;
  ahead: number;
  behind: number;
  unpushed: number;
  /** Uncommitted changes. */
  working: WorkFile[];
  /** Committed on the branch, against its base. */
  committed: SourceFile[];
  /** Lines committed elsewhere on the branch that the demo never opens. */
  extraAdd: number;
  extraDel: number;
}

const committedStub = (paths: string[]): SourceFile[] =>
  paths.map((path) => ({ path, oldText: "", newText: "" }));

export const wt = (w: Partial<WtState> & Pick<WtState, "id" | "repo">): WtState => {
  const seed = ticketSeed(w.id);
  return {
    title: seed?.title ?? w.id,
    branch: branchFor(w.id, seed?.title ?? w.id),
    baseBranch: "main",
    status: seed?.status ?? null,
    agent: null,
    setupRan: true,
    ahead: 0,
    behind: 0,
    unpushed: 0,
    working: [],
    committed: [],
    extraAdd: 0,
    extraDel: 0,
    ...w,
  };
};

export const worktreesState: WtState[] = [
  wt({
    id: "PLAT-401",
    repo: PLATFORM,
    agent: "Claude",
    ahead: 6,
    committed: committedStub([
      "src/events/scanEvents.ts",
      "src/carriers/adapter.ts",
      "src/carriers/ups.ts",
      "src/carriers/usps.ts",
    ]),
    extraAdd: 486,
    extraDel: 52,
  }),
  wt({
    id: "PLAT-402",
    repo: PLATFORM,
    agent: "Claude",
    baseBranch: BRANCH["PLAT-401"],
    ahead: 3,
    committed: committedStub(["src/events/normalize.ts", "src/events/codes/ups.ts"]),
    extraAdd: 318,
    extraDel: 41,
  }),
  wt({
    id: "PLAT-404",
    repo: PLATFORM,
    agent: "Claude",
    baseBranch: BRANCH["PLAT-402"],
    ahead: 1,
    unpushed: 1,
    committed: committedStub(["src/events/backfill/index.ts"]),
    extraAdd: 129,
    extraDel: 8,
  }),
  wt({
    id: "DRV-91",
    repo: DRIVER,
    agent: "Codex",
    ahead: 2,
    unpushed: 2,
    committed: committedStub(["src/scan/queue.ts", "src/scan/useScanner.ts"]),
    extraAdd: 212,
    extraDel: 30,
  }),
];

export const findWt = (repo: string, id: string) =>
  worktreesState.find((w) => w.repo === repo && w.id === id);

const lines = (files: { oldText: string; newText: string }[]) =>
  files.reduce(
    (acc, f) => {
      const d = diffOf(f.oldText, f.newText);
      return { add: acc.add + d.additions, del: acc.del + d.deletions };
    },
    { add: 0, del: 0 },
  );

export function wtLines(w: WtState) {
  const c = lines(w.committed);
  const u = lines(w.working);
  return { add: c.add + u.add + w.extraAdd, del: c.del + u.del + w.extraDel };
}

export function changedFiles(files: WorkFile[]): ChangedFile[] {
  return files.map((f) => {
    const d = diffOf(f.oldText, f.newText);
    return {
      path: f.path,
      oldPath: null,
      status: f.status,
      staged: f.staged,
      addLines: d.additions,
      delLines: d.deletions,
      binary: false,
    };
  });
}

export function branchChanges(files: SourceFile[]): ChangedFile[] {
  return files.map((f) => {
    const d = diffOf(f.oldText, f.newText);
    const stub = f.newText === "" && f.oldText === "";
    return {
      path: f.path,
      oldPath: null,
      status: f.oldText === "" ? "Added" : "Modified",
      staged: false,
      addLines: stub ? 24 + f.path.length : d.additions,
      delLines: stub ? f.path.length % 7 : d.deletions,
      binary: false,
    };
  });
}

/** Stage or unstage a path, or everything under a folder. */
export function setStaged(w: WtState, path: string | null, staged: boolean) {
  for (const f of w.working) {
    if (path === null || f.path === path || f.path.startsWith(`${path.replace(/\/$/, "")}/`)) {
      f.staged = staged;
    }
  }
}

export const commitDrafts = new Map<string, string>();

// ── PRs ──────────────────────────────────────────────────────────────────────

/** Which PR each worktree has, by worktree id. */
export const worktreePrNumbers = new Map<string, { repo: string; number: number }>([
  ["PLAT-401", { repo: PLATFORM, number: 1279 }],
  ["PLAT-402", { repo: PLATFORM, number: 1284 }],
]);

export interface OpenedPr {
  repo: string;
  number: number;
  worktreeId: string;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  files: SourceFile[];
  openedAt: number;
  draft: boolean;
  /** CI on it has gone green and the views were told. */
  settledAnnounced?: boolean;
}

/** PRs opened during the demo. */
export const openedPrs: OpenedPr[] = [];
let nextPrNumber = 1293;
export const takePrNumber = () => nextPrNumber++;

export const prKey = (repo: string, n: number) => `${repo}#${n}`;

/** The hero's PR once it is opened: the clock its comments and CI run on. */
export let heroPr: HeroPr | null = null;

export function openHeroPr(number: number, now: number) {
  heroPr = { number, speed: agentSpeed(), openedAt: now, fixedAt: null };
}

export function pushHeroFix(now: number) {
  if (heroPr && heroPr.fixedAt === null) heroPr.fixedAt = now;
}

export const isHeroPr = (repo: string, n: number) => repo === HERO_REPO && heroPr?.number === n;

// ── The AI review's output and the work queue ────────────────────────────────

export const drafts = new Map<string, ReviewDraft[]>();
export const briefs = new Map<string, ReviewBrief>();
export const workItems = new Map<string, ReviewWorkItem[]>();

// ── Agents ───────────────────────────────────────────────────────────────────

export type JobRole = "work" | "aiReview" | "fixCi";

export interface Job {
  termKey: string;
  repo: string;
  worktreeId: string;
  kind: AgentKind;
  role: JobRole;
  script: Script;
  /** Wall clock the script's second 0 maps to. */
  startedAt: number;
  sessionId: string;
  cwd: string;
  /** Script beats (by `at`) whose side effects have already run. */
  fired: Set<string>;
  pr?: { repo: string; number: number };
  /** Work-item ids a queue run is working through, in script order. */
  items?: string[];
  /** The agent speed when the job started. */
  speed: AgentSpeed;
}

export const jobs = new Map<string, Job>();

/** How much faster than real time scripted agents, the hero PR's CI and its
 *  coworkers work (Settings → Demo). */
export type AgentSpeed = 1 | 1.5 | 2 | 3;
const SPEED_KEY = "santree.demo.agentSpeed";

export function agentSpeed(): AgentSpeed {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return v === 1 || v === 1.5 || v === 2 || v === 3 ? v : 2;
  } catch {
    return 2;
  }
}

export function setAgentSpeed(speed: AgentSpeed) {
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    // Storage refused: the default speed stays.
  }
}

/** Script seconds a job has run: wall time scaled by the speed it started at,
 *  so changing the speed never makes a running agent jump. */
export const jobSecs = (job: Job, now = Date.now()) => ((now - job.startedAt) / 1000) * job.speed;

const uuid = () => crypto.randomUUID();

export function jobState(job: Job, now = Date.now()): AgentState {
  return isDone(job.script, jobSecs(job, now)) ? "idle" : "active";
}

type NewJob = Omit<Job, "fired" | "sessionId" | "speed"> & { sessionId?: string };

function addJob(j: NewJob): Job {
  const job: Job = {
    ...j,
    sessionId: j.sessionId ?? uuid(),
    fired: new Set(),
    speed: agentSpeed(),
  };
  jobs.set(job.termKey, job);
  return job;
}

export function startJob(j: NewJob): Job {
  const job = addJob(j);
  sessionsMoved();
  return job;
}

/** The agents already at work when the demo opens: termKey → how far in. */
export const OPENING_AGENTS: {
  termKey: string;
  worktreeId: string;
  repo: string;
  kind: AgentKind;
  tab: WorktreeTab;
  secsIn: number;
}[] = [
  {
    termKey: "tree:PLAT-404:tab:t-404",
    worktreeId: "PLAT-404",
    repo: PLATFORM,
    kind: "Claude",
    tab: {
      id: "t-404",
      worktreeId: "PLAT-404",
      kind: "agent",
      agentKind: "Claude",
      title: "Claude Code",
      pr: null,
    },
    secsIn: 18,
  },
  {
    termKey: "tree:DRV-91:tab:t-91",
    worktreeId: "DRV-91",
    repo: DRIVER,
    kind: "Codex",
    tab: {
      id: "t-91",
      worktreeId: "DRV-91",
      kind: "agent",
      agentKind: "Codex",
      title: "Codex",
      pr: null,
    },
    secsIn: 9,
  },
];

// Seeded silently: this runs at import, before anything listens.
for (const a of OPENING_AGENTS) {
  addJob({
    termKey: a.termKey,
    repo: a.repo,
    worktreeId: a.worktreeId,
    kind: a.kind,
    role: "work",
    script: scriptFor(a.worktreeId, ticketSeed(a.worktreeId)?.title ?? a.worktreeId),
    startedAt: T0 - (a.secsIn * SEC) / agentSpeed(),
    cwd: worktreePath(a.repo, a.worktreeId),
  });
}

export const tabs: WorktreeTab[] = OPENING_AGENTS.map((a) => a.tab);
/** Which tab a `tree:<wt>:tab:<id>` key is. */
export const tabOf = (termKey: string) => {
  const id = termKey.split(":tab:")[1];
  return id ? tabs.find((t) => t.id === id) : undefined;
};

/** Pick the job for a pane the app just opened, starting one if it is new. */
export function jobForPane(
  termKey: string,
  kind: AgentKind,
  cwd: string,
  repo: string,
  worktreeId: string,
): Job {
  const existing = jobs.get(termKey);
  if (existing) return existing;
  const tab = tabOf(termKey);
  const role: JobRole =
    tab?.kind === "aiReview" ? "aiReview" : tab?.kind === "fixCi" ? "fixCi" : "work";
  const pr = tab?.pr ?? (heroPr ? { repo: HERO_REPO, number: heroPr.number } : undefined);
  const base = { termKey, repo, worktreeId, kind, role, startedAt: Date.now(), cwd };
  if (role === "fixCi" && pr) {
    const open = (workItems.get(prKey(pr.repo, pr.number)) ?? []).filter((i) => !i.done);
    return startJob({
      ...base,
      script: queueRunScript(
        open.map((i) => i.body),
        pr.number,
      ),
      pr,
      items: open.map((i) => i.id),
    });
  }
  if (role === "aiReview" && pr) {
    return startJob({ ...base, script: aiReviewScript(pr.number), pr });
  }
  return startJob({
    ...base,
    script: scriptFor(worktreeId, ticketSeed(worktreeId)?.title ?? worktreeId),
  });
}

/** The file a script step writes, if it is one of the hero's. */
function heroFileOf(step: Step): SourceFile | undefined {
  const path =
    "edit" in step ? step.edit : "tool" in step && step.tool === "Write" ? step.arg : null;
  return path ? HERO_V1.find((f) => f.path === path) : undefined;
}

// ── The clock that moves scripted work forward ───────────────────────────────

function fireOnce(job: Job, beat: string, now: number, at: number, effect: () => void) {
  if (job.fired.has(beat) || jobSecs(job, now) < at) return;
  job.fired.add(beat);
  effect();
}

function tick() {
  const now = Date.now();
  for (const job of jobs.values()) {
    const key = job.pr ? prKey(job.pr.repo, job.pr.number) : "";

    // The hero's edits land in Changes as its screen prints them.
    if (job.role === "work" && job.worktreeId === HERO) {
      for (const step of job.script.steps) {
        const file = heroFileOf(step);
        if (!file) continue;
        fireOnce(job, `file-${file.path}`, now, step.at, () => {
          const w = findWt(job.repo, job.worktreeId);
          if (!w || w.working.some((f) => f.path === file.path)) return;
          w.working.push({
            ...file,
            status: file.oldText === "" ? "Untracked" : "Modified",
            staged: false,
          });
          worktreeMoved(w.repo, w.id, { files: true });
        });
      }
    }

    if (job.role === "aiReview" && heroPr && job.pr?.number === heroPr.number) {
      const pr = heroPr;
      fireOnce(job, "brief", now, 8.6, () => {
        briefs.set(key, heroBrief(job.kind, pr, now));
        void events.reviewAiChanged.emit({});
      });
      const all = heroDrafts(job.kind, pr, now);
      [9.8, 11.0, 12.2].forEach((at, i) => {
        fireOnce(job, `draft-${i}`, now, at, () => {
          drafts.set(key, all.slice(0, i + 1));
          void events.reviewAiChanged.emit({});
          // The PR's own header counts the drafts, and it is a polled read.
          refreshPolled("prSummaryPrefix");
        });
      });
    }

    if (job.role === "fixCi" && job.items) {
      const ids = job.items;
      // Tick items off as the script's plan does, spread over its edits.
      ids.forEach((id, i) => {
        const at = 6 + ((17.5 - 6) * (i + 1)) / ids.length;
        fireOnce(job, `item-${id}`, now, at, () => {
          const item = (workItems.get(key) ?? []).find((x) => x.id === id);
          if (item) {
            item.done = true;
            item.updatedAtMs = now;
          }
          void events.reviewAiChanged.emit({});
        });
      });
      // The run can't commit or push (its settings deny both): its fixes land
      // as uncommitted changes, for the user to commit and push.
      fireOnce(job, "edits", now, 19.5, () => {
        const w = findWt(HERO_REPO, HERO);
        if (!w || !heroPr || job.pr?.number !== heroPr.number) return;
        w.working = heroFixChanges().map((f) => ({
          ...f,
          status: f.oldText === "" ? ("Untracked" as const) : ("Modified" as const),
          staged: false,
        }));
        worktreeMoved(w.repo, w.id, { files: true });
      });
    }

    // Session rows flip to idle the moment a script finishes.
    fireOnce(job, "done", now, job.script.doneAt ?? Number.POSITIVE_INFINITY, sessionsMoved);
  }

  // The hero PR comes alive: every beat refreshes what it changed, and while
  // CI runs its "In progress · 12s" counters tick along.
  if (heroPr) {
    for (const at of heroBeatTimes(heroPr)) {
      if (now >= at && !announced.has(at)) {
        announced.add(at);
        refreshPolled("prDetailPrefix", "prSummaryPrefix", "reviewsPrefix", "mergeQueuePrefix");
      }
    }
    if (heroChecks(heroPr, now) !== "Success" && now - lastCiTick >= 3 * SEC) {
      lastCiTick = now;
      refreshPolled("prDetailPrefix");
    }
  }
  for (const pr of openedPrs) {
    if (!pr.settledAnnounced && now - pr.openedAt > 25 * SEC) {
      pr.settledAnnounced = true;
      refreshPolled("prDetailPrefix", "prSummaryPrefix");
    }
  }
}

/** PR beats already announced, by wall-clock time. */
const announced = new Set<number>();
let lastCiTick = 0;

let clockStarted = false;

/** Start moving scripted work forward. Called by the installer rather than at
 *  import: Vite pre-bundles a second copy of this module for the Tauri plugins
 *  (they import the aliased `invoke` too), and that copy must stay inert. */
export function startClock() {
  if (clockStarted) return;
  clockStarted = true;
  setInterval(tick, 500);
}
