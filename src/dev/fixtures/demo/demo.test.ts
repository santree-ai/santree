/**
 * The demo script, end to end, against the demo commands alone: the same
 * commands the app sends at each beat of the recording, in order, through
 * their typed signatures. Keeps the demo world from silently rotting between
 * rehearsals.
 */
import type { Channel } from "@tauri-apps/api/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type AgentKind,
  events,
  type NewReviewWorkItem,
  type ReviewTarget,
  type StreamEvent,
  type TabKind,
  type TabPr,
} from "../../../bindings";
import type { Commands } from "./handlers";

let demo: Partial<Commands>;

/** The demo's override for a command; a missing one fails the test. */
const cmd = <K extends keyof Commands>(k: K): Commands[K] => {
  const f = demo[k];
  if (!f) throw new Error(`the demo does not answer ${k}`);
  return f;
};

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: string };

async function unwrap<T>(res: Promise<Result<T>>): Promise<T> {
  const r = await res;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Wait out a command that sleeps, letting fake time pass meanwhile. */
const settle = async <T>(res: Promise<Result<T>>, ms = 5_000) => {
  const p = unwrap(res);
  await advance(ms);
  return p;
};

/** The real commands the demo may lean on: the Daedalus half's live data. */
const REAL_ALLOWED: Partial<Commands> = {
  listRepos: async () => ({ status: "ok", data: [] }),
  sessionStates: async () => ({ status: "ok", data: [] }),
  agentProcesses: async () => ({ status: "ok", data: [] }),
  terminalSessions: async () => ({ status: "ok", data: [] }),
};
const realCalls: string[] = [];
/** Records every real call; anything outside `REAL_ALLOWED` throws, so a
 *  demo command that forwards demo data to the backend fails loudly. */
const fakeReal = new Proxy(REAL_ALLOWED, {
  get:
    (allowed, name: string) =>
    (...args: unknown[]) => {
      realCalls.push(name);
      const f = allowed[name as keyof Commands] as ((...a: unknown[]) => unknown) | undefined;
      if (!f) throw new Error(`unexpected real call: ${name}`);
      return f(...args);
    },
  // The double answers every name, so it stands in for the whole object.
}) as Commands;

/** The channels the app passes are Tauri's; here, a plain sink is enough. */
const sink = <T>(onmessage: (m: T) => void = () => {}) => ({ onmessage }) as unknown as Channel<T>;

const PLATFORM = "parcelwise/platform";
const WT = (id: string) => `/Users/santiago/dev/parcelwise/platform/.santree/worktrees/${id}`;
const INFRA = "parcelwise/infra";
const WTI = (id: string) => `/Users/santiago/dev/parcelwise/infra/.santree/worktrees/${id}`;

beforeAll(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  // No Tauri here: the events go nowhere, and the spies say which were sent.
  for (const e of [
    events.worktreeBasesChanged,
    events.worktreeChanged,
    events.sessionStateChanged,
    events.reviewAiChanged,
  ]) {
    vi.spyOn(e, "emit").mockResolvedValue(undefined);
  }
  // Real time, so the beats below read as the script's own seconds.
  localStorage.setItem("santree.demo.agentSpeed", "1");
  const { buildDemoCommands } = await import("./handlers");
  (await import("./state")).startClock();
  demo = buildDemoCommands(fakeReal);
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the Santree demo", () => {
  const worktreesOf = (repo: string) => unwrap(cmd("worktrees")(repo));
  const sessionStates = () => unwrap(cmd("sessionStates")());

  it("opens on three projects with chained worktrees", async () => {
    const repos = await unwrap(cmd("listRepos")());
    expect(repos.map((r) => r.name)).toEqual([INFRA, PLATFORM, "parcelwise/driver-app"]);
    const byId = new Map((await worktreesOf(PLATFORM)).map((w) => [w.id, w]));
    expect(byId.get("PLAT-402")?.baseBranch).toBe(byId.get("PLAT-401")?.branch);
    expect(byId.get("PLAT-404")?.baseBranch).toBe(byId.get("PLAT-402")?.branch);
  });

  it("has exactly four ready tickets across the org", async () => {
    const started = new Set<string>();
    for (const repo of [PLATFORM, "parcelwise/driver-app", INFRA]) {
      for (const w of await worktreesOf(repo)) started.add(w.id);
    }
    // One org behind every repo: any of them answers with all of its tickets.
    const tasks = await unwrap(cmd("linearListIssues")(INFRA));
    const ready = tasks
      .filter((t) => t.ready && t.actionable && !started.has(t.id))
      .map((t) => t.id);
    expect(ready.sort()).toEqual(["PLAT-418", "PLAT-421", "PLAT-424", "PLAT-427"]);
  });

  it("launches into infra, listed first", async () => {
    const repos = await unwrap(cmd("listRepos")());
    expect(repos[0].name).toBe(INFRA);
    expect(await unwrap(cmd("resolveSetting")(INFRA, "work_default_repo"))).toBe(INFRA);
  });

  const detail = (n: number) => unwrap(cmd("prDetail")("parcelwise", "infra", n));
  const open = (label: string, cwd: string, agentKind: AgentKind) =>
    unwrap(
      cmd("terminalOpen")(
        { cwd, command: "", args: [], cols: 100, rows: 40, owner: "o", label, agentKind },
        sink(),
        sink(),
      ),
    );
  const addTab = (worktreeId: string, id: string, kind: TabKind, pr: TabPr | null = null) =>
    unwrap(cmd("addWorktreeTab")(INFRA, worktreeId, id, kind, "Claude", kind, pr));
  const ISSUE = "PLAT-421";
  const status = () => unwrap(cmd("worktreeStatus")(INFRA, ISSUE));
  const target = (number: number): ReviewTarget => ({
    prRepo: INFRA,
    number,
    title: "",
    author: "",
    headRef: "",
    baseRef: "",
    headSha: "",
    ticketId: null,
  });
  let prNumber = 0;

  it("launches four tickets together: worktrees, setup, working agents", async () => {
    const ids = ["PLAT-418", "PLAT-421", "PLAT-424", "PLAT-427"];
    const creates = ids.map((id) =>
      unwrap(
        cmd("createWorktree")(
          INFRA,
          id,
          id,
          { type: "ticket", project: null },
          null,
          id === "PLAT-427" ? "Codex" : "Claude",
        ),
      ),
    );
    // Every launch is listed before the first create answers.
    const listed = (await worktreesOf(INFRA)).map((w) => w.id);
    expect(ids.every((id) => listed.includes(id))).toBe(true);
    await advance(1_000);
    await Promise.all(creates);

    const streamed: StreamEvent[] = [];
    await settle(
      cmd("runWorktreeSetupStreamed")(
        INFRA,
        ISSUE,
        sink((e) => streamed.push(e)),
      ),
    );
    expect(streamed.at(-1)).toEqual({ type: "done", ok: true });

    await addTab(ISSUE, "tab-421", "agent");
    await open("tree:PLAT-421:tab:tab-421", WTI(ISSUE), "Claude");
    const states = await sessionStates();
    expect(states.find((s) => s.termKey === "tree:PLAT-421:tab:tab-421")?.state).toBe("active");
    expect(events.sessionStateChanged.emit).toHaveBeenCalled();
  });

  it("the hero agent finishes fast, its edits landing in Changes as it goes", async () => {
    await advance(13_000);
    const midway = await status();
    expect(midway.length).toBeGreaterThan(0);
    expect(midway.length).toBeLessThan(5);
    expect(events.worktreeChanged.emit).toHaveBeenCalledWith({ issueId: ISSUE });
    await advance(11_000);
    expect(await status()).toHaveLength(5);
    const states = await sessionStates();
    expect(states.find((s) => s.termKey === "tree:PLAT-421:tab:tab-421")?.state).toBe("idle");
  });

  it("commits, pushes and opens the PR", async () => {
    await settle(cmd("stageAllPaths")(INFRA, ISSUE), 200);
    const message = await settle(cmd("commitMessage")(INFRA, ISSUE));
    expect(message).toMatch(/^fix\(webhooks\): claim deliveries/);
    vi.mocked(events.worktreeBasesChanged.emit).mockClear();
    await settle(cmd("commitWorktree")(INFRA, ISSUE, message, false));
    expect(events.worktreeBasesChanged.emit).toHaveBeenCalledWith({
      repo: INFRA,
      issueIds: [ISSUE],
    });
    expect(await status()).toEqual([]);
    // With nothing left, a second commit is refused as git would refuse it.
    const again = cmd("commitWorktree")(INFRA, ISSUE, message, false);
    await advance(1_000);
    expect(await again).toEqual({ status: "error", error: "nothing to commit" });
    await settle(cmd("pushWorktree")(INFRA, ISSUE));
    const draft = await settle(cmd("prDraft")(INFRA, ISSUE, true, false));
    expect(draft.body).toContain("Fixes PLAT-421");
    const pr = await settle(
      cmd("createPullRequest")(INFRA, ISSUE, draft.title, draft.body, false, []),
      2_000,
    );
    prNumber = pr.number;
    const prs = await unwrap(cmd("worktreePrs")(INFRA));
    expect(prs.find((p) => p.issueId === ISSUE)?.number).toBe(prNumber);
  });

  it("the PR comes alive: CI runs for a while, comments arrive, two jobs fail", async () => {
    const statuses = async () =>
      Object.fromEntries((await detail(prNumber)).checks.map((c) => [c.name, c.status]));
    const fresh = await detail(prNumber);
    expect(fresh.checks.filter((c) => c.status === "Pending").length).toBeGreaterThan(8);
    expect(fresh.threads).toHaveLength(0);

    await advance(9_000);
    const midway = await statuses();
    expect(midway["Preview deploy"]).toBe("Skipped");
    expect(midway["CI / install"]).toBe("Success");
    expect(midway["CI / e2e (chromium)"]).toBe("Pending");
    expect(midway["CI / typecheck"]).toBe("Pending");

    await advance(31_000);
    const live = await detail(prNumber);
    expect(live.threads).toHaveLength(2);
    expect(live.comments.length).toBeGreaterThanOrEqual(2);
    expect(
      live.checks
        .filter((c) => c.status === "Failure")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["CI / typecheck", "CI / unit (2/3)"]);
    expect(live.checks.some((c) => c.status === "Neutral")).toBe(true);
    expect(live.checks.some((c) => c.status === "Pending")).toBe(false);
  });

  it("runs an AI review that writes a brief and three drafts", async () => {
    vi.mocked(events.reviewAiChanged.emit).mockClear();
    await addTab(ISSUE, "tab-review", "aiReview", { repo: INFRA, number: prNumber });
    await open("tree:PLAT-421:tab:tab-review", WTI(ISSUE), "Claude");
    await advance(14_000);
    expect(await unwrap(cmd("reviewDrafts")(INFRA, prNumber))).toHaveLength(3);
    const brief = await unwrap(cmd("prReviewBrief")(INFRA, prNumber));
    expect(brief?.readingOrder).toHaveLength(5);
    // The brief and each of the three drafts announced themselves.
    expect(events.reviewAiChanged.emit).toHaveBeenCalledTimes(4);
  });

  it("works the queue, the push turns CI green, and it joins the merge queue", async () => {
    const add = (id: string, source: NewReviewWorkItem["source"], body: string) =>
      unwrap(
        cmd("addReviewWorkItem")(INFRA, prNumber, {
          id,
          body,
          source,
          sourceId: null,
          path: null,
          line: null,
          startLine: null,
          onRight: null,
        }),
      );
    await add("w1", "githubThread", "The lease is shorter than the request timeout.");
    await add("w2", "check", "Fix failing check: test");
    await add("w3", "aiDraft", "Claim in one statement.");

    await settle(cmd("reviewFixLaunch")(INFRA, target(prNumber)), 1_000);
    await addTab(ISSUE, "tab-fix", "fixCi", { repo: INFRA, number: prNumber });
    await open("tree:PLAT-421:tab:tab-fix", WTI(ISSUE), "Claude");
    await advance(22_000);
    const items = await unwrap(cmd("reviewWorkItems")(INFRA, prNumber));
    expect(items.every((i) => i.done)).toBe(true);

    expect((await status()).length).toBeGreaterThan(0);
    await settle(cmd("stageAllPaths")(INFRA, ISSUE), 200);
    const message = await settle(cmd("commitMessage")(INFRA, ISSUE));
    expect(message).toMatch(/renew the lease/);
    await settle(cmd("commitWorktree")(INFRA, ISSUE, message, false));
    await settle(cmd("pushWorktree")(INFRA, ISSUE));
    const running = await detail(prNumber);
    expect(running.checks.filter((c) => c.status === "Pending").length).toBeGreaterThan(8);
    expect(running.threads.every((t) => t.isResolved)).toBe(true);
    await advance(36_000);
    const green = (await detail(prNumber)).checks;
    expect(green.every((c) => c.status === "Success" || c.status === "Skipped")).toBe(true);

    const view = await unwrap(cmd("mergeQueue")(INFRA));
    const mine = view.queue?.entries.find((e) => e.prNumber === prNumber);
    expect(mine?.isMine).toBe(true);
    expect(mine?.position).toBe(6);
  });

  it("never reached the real backend for demo data", () => {
    expect(realCalls.every((c) => c in REAL_ALLOWED)).toBe(true);
  });
});

describe("agent screens", () => {
  it("pin the composer to the bottom of the pane", async () => {
    const { renderScreen, scriptFor } = await import("./screens");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point.
    const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    for (const kind of ["Claude", "Codex"] as const) {
      const out = strip(
        renderScreen(scriptFor("PLAT-424", "x"), {
          kind,
          cwd: WT("PLAT-424"),
          cols: 100,
          rows: 40,
          secs: 3,
        }),
      ).split("\r\n");
      expect(out).toHaveLength(39);
      // Not `findLastIndex`: the test tsconfig's lib predates ES2023.
      const fromEnd = [...out]
        .reverse()
        .findIndex((l) => l.startsWith("╭") || l.includes("Ask Codex"));
      const composer = fromEnd === -1 ? -1 : out.length - 1 - fromEnd;
      expect(composer).toBeGreaterThan(30);
    }
  });
});

describe("demo speed", () => {
  it("runs a job's script that much faster", async () => {
    const { startJob, jobSecs, setAgentSpeed } = await import("./state");
    const { scriptFor } = await import("./screens");
    setAgentSpeed(3);
    const job = startJob({
      termKey: "tree:PLAT-424:tab:speed",
      repo: PLATFORM,
      worktreeId: "PLAT-424",
      kind: "Claude",
      role: "work",
      script: scriptFor("PLAT-424", "x"),
      startedAt: Date.now() - 2_000,
      cwd: WT("PLAT-424"),
    });
    expect(jobSecs(job)).toBeCloseTo(6);
    setAgentSpeed(1);
  });
});
