/**
 * The demo world as `commands` overrides. Every command that names a demo repo
 * (or a demo checkout, PR or terminal) is answered here; everything else —
 * Daedalus, settings, prompts, the agent catalog, real terminals — goes to the
 * real command, which is what lets the Daedalus half of the demo run live in
 * the same window.
 *
 * Each entry is typed as the generated command it replaces (positional
 * arguments, `Result` return), so a command renamed or reshaped in Rust fails
 * `tsc` here once the bindings are regenerated.
 */
import type {
  CmdError,
  commands,
  PrLabel,
  Repo,
  ReviewWorkItem,
  WorktreePr,
} from "../../../bindings";
import { PLATFORM_FILES } from "./code";
import {
  avatar,
  DAY,
  DRIVER,
  HOUR,
  INFRA,
  isDemoPath,
  isDemoRepo,
  LINEAR_ORG,
  LOGIN,
  ME,
  ME_LOGIN,
  MIN,
  PEOPLE,
  PLATFORM,
  REPO_PATH,
  SEC,
  ticketSeed,
} from "./company";
import { gitDiff } from "./diff";
import {
  HERO,
  HERO_REPO,
  heroChecks,
  heroDecision,
  heroJobLog,
  heroPrDetail,
  heroPrFiles,
} from "./hero";
import {
  genericDetail,
  mergeQueue,
  newPrDetail,
  PR_SEEDS,
  prTickets,
  prUrl,
  reviewInbox,
  toReviewPr,
} from "./prs";
import { setupChunks } from "./screens";
import {
  branchChanges,
  briefs,
  changedFiles,
  commitDrafts,
  drafts,
  findWt,
  heroPr,
  isHeroPr,
  wt as newWt,
  openedPrs,
  openHeroPr,
  prKey,
  pushHeroFix,
  refreshPolled,
  setStaged,
  sleep,
  T0,
  tabs,
  takePrNumber,
  workItems,
  worktreeMoved,
  worktreePrNumbers,
  worktreesState,
} from "./state";
import {
  attachFake,
  closeFake,
  detachFake,
  fakeAgentProcesses,
  fakeSessions,
  isFakePty,
  locate,
  openFake,
  resizeFake,
} from "./terminal";
import {
  baseWorktree,
  demoRepos,
  linearTeams,
  sessionStates,
  tasks,
  ticketDetail,
  toWorktree,
  triageSchedule,
  triageTickets,
  worktreeSessions,
  worktrees,
} from "./world";

export type Commands = typeof commands;

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: CmdError };

const ok = <T>(data: T): Result<T> => ({ status: "ok", data });
const err = <T = never>(error: CmdError): Result<T> => ({ status: "error", error });

/** A real command's data, or `fallback` when it failed. */
async function dataOr<T>(res: Promise<Result<T>>, fallback: T): Promise<T> {
  try {
    const r = await res;
    return r.status === "ok" ? r.data : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Route a command by its first argument — a repo, or the PR's repo: the demo
 * answers for a demo repo, the real command for anything else. `real` comes
 * first so it fixes the signature; `mine` is checked against it, not the other
 * way round.
 */
const forRepo =
  <A extends [string, ...unknown[]], R>(
    real: (...a: A) => Promise<R>,
    mine: NoInfer<(...a: A) => Promise<R>>,
  ) =>
  (...a: A): Promise<R> =>
    isDemoRepo(a[0]) ? mine(...a) : real(...a);

/** The same, for the GitHub commands that take the repo as `owner, name`. */
const forGithub =
  <A extends [string, string, ...unknown[]], R>(
    real: (...a: A) => Promise<R>,
    mine: NoInfer<(...a: A) => Promise<R>>,
  ) =>
  (...a: A): Promise<R> =>
    isDemoRepo(`${a[0]}/${a[1]}`) ? mine(...a) : real(...a);

/** The same, for a terminal command addressed by PTY id. */
const forPty =
  <A extends [number, ...unknown[]], R>(
    real: (...a: A) => Promise<R>,
    mine: NoInfer<(...a: A) => Promise<R>>,
  ) =>
  (...a: A): Promise<R> =>
    isFakePty(a[0]) ? mine(...a) : real(...a);

const DEMO_LABELS: PrLabel[] = [
  { name: "api", color: "db2777", description: "Public API" },
  { name: "incident-follow-up", color: "d97706", description: null },
  { name: "returns", color: "0ea5a4", description: null },
  { name: "tracking", color: "5e6ad2", description: null },
];

/** Settings that name a repo or shape the demo's pace. Everything else is the
 *  real settings store, so the chrome stays honest. */
const SETTING_OVERRIDES: Record<string, string> = {
  triage_default_repo: PLATFORM,
  // The four launches land in infra, their own project at the top of the
  // sidebar; the graph still shows the whole org.
  work_default_repo: INFRA,
  // No "Start N tasks" dialog: run setup for every launch, never ask about stacking.
  trees_batch_setup: "always",
  trees_run_setup: "true",
  work_ask_base: "false",
  // Stage by hand, then one click commits, pushes and opens the PR dialog.
  trees_stage_all: "false",
  trees_auto_push: "true",
  trees_auto_pr: "true",
};

const settingOverride = (key: string) =>
  SETTING_OVERRIDES[key] ?? (key.startsWith("triage_repo:") ? PLATFORM : undefined);

/** A demo PR, by repo and number: mine, a coworker's, or one opened today. */
function prSummaryOf(repo: string, n: number, now: number) {
  const opened = openedPrs.find((p) => p.repo === repo && p.number === n);
  if (opened) {
    const hero = isHeroPr(repo, n) ? heroPr : null;
    const detail = prDetailOf(repo, n, now);
    const files = detail?.files ?? [];
    return toReviewPr(
      {
        repo,
        number: n,
        title: opened.title,
        author: ME,
        headRef: opened.headRef,
        baseRef: opened.baseRef,
        createdAgo: now - opened.openedAt,
        waitingAgo: now - opened.openedAt,
        pushedAgo: now - opened.openedAt,
        additions: files.reduce((sum, f) => sum + f.additions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
        changedFiles: files.length,
        comments: (detail?.comments.length ?? 0) + (detail?.threads.length ?? 0),
        checks: hero
          ? heroChecks(hero, now)
          : detail?.checks.some((c) => c.status === "Pending")
            ? "Pending"
            : "Success",
        decision: hero ? heroDecision(hero, now) : "ReviewRequired",
        isDraft: opened.draft,
        section: "mine",
        body: opened.body,
      },
      now,
      {
        headSha: detail?.headSha,
        pushedAt: hero?.fixedAt ?? undefined,
        aiDraftCount: drafts.get(prKey(repo, n))?.length ?? 0,
      },
    );
  }
  const seed = PR_SEEDS.find((p) => p.repo === repo && p.number === n);
  return seed ? toReviewPr(seed, now) : null;
}

function prDetailOf(repo: string, n: number, now: number) {
  const opened = openedPrs.find((p) => p.repo === repo && p.number === n);
  if (opened && isHeroPr(repo, n) && heroPr) return heroPrDetail(heroPr, opened.body, now);
  if (opened)
    return newPrDetail(repo, opened.title, opened.body, opened.files, opened.openedAt, now);
  const seed = PR_SEEDS.find((p) => p.repo === repo && p.number === n);
  return seed ? genericDetail(seed, T0) : null;
}

/** The AI commit message for a worktree: the hero's first commit, then its fix. */
function commitMessageFor(id: string): string {
  if (id === HERO && heroPr) {
    return `fix(webhooks): renew the lease, key per endpoint

- Claim deliveries in one UPDATE … FOR UPDATE SKIP LOCKED, so two
  workers can never take the same one
- Renew the lease while the request is in flight, so an endpoint
  slower than the lease no longer gets a second delivery
- Idempotency-Key per event and endpoint; free the lease on failure
- Index the claim query; count lease expirations

Addresses review on #${heroPr.number}`;
  }
  if (id === HERO) {
    return `fix(webhooks): claim deliveries with a lease before sending

A delivery was only marked done after the HTTP call returned, so an
endpoint slower than the poll interval was picked up again by another
worker and received the event two or three times. Workers now lease a
delivery before sending it, and every delivery carries an
Idempotency-Key so shippers can drop the retries we do send.

Fixes PLAT-421`;
  }
  return `feat: ${(ticketSeed(id)?.title ?? id).toLowerCase()}\n\nRefs ${id}`;
}

const PR_BODIES: Record<string, string> = {
  [HERO]: `## Why

Shippers receive \`shipment.delivered\` two or three times when their endpoint is slow (PLAT-421). A delivery is only marked done after the HTTP call returns, so another worker picks it up again once the poll comes round — two enterprise shippers refund on \`delivered\`, so the duplicates cost them money.

## What

- Workers claim a delivery with a lease (\`lease_until\`) before sending it, and skip anything another worker holds
- Every delivery carries an \`Idempotency-Key\`, so shippers can drop the retries we do send
- Docs for the new header

## Testing

- New tests for endpoints slower than the poll interval and slower than the lease
- \`pnpm vitest run src/webhooks\` passes locally

Fixes PLAT-421`,
};

export function buildDemoCommands(real: Commands): Partial<Commands> {
  const now = () => Date.now();

  const realRepos = async (): Promise<Repo[]> =>
    (await dataOr(real.listRepos(), [])).filter((r) => r.location === "Daedalus");

  return {
    // ── Registry ───────────────────────────────────────────────────────────
    // Demo projects first; real ones only from Daedalus, so the home server's
    // section stays live and no local checkout's name shows up.
    listRepos: async () => ok([...demoRepos(), ...(await realRepos())]),
    watchWorktrees: forRepo(real.watchWorktrees, async () => ok(null)),
    legacyCliProbe: async () => ok(null),
    checkForUpdate: async () => ok(null),
    repoBranches: forRepo(real.repoBranches, async (repo) =>
      ok([
        {
          name: "main",
          hasWorktree: true,
          remoteOnly: false,
          updatedAt: new Date(now() - HOUR).toISOString(),
        },
        ...worktrees(repo).map((w) => ({
          name: w.branch,
          hasWorktree: true,
          remoteOnly: false,
          updatedAt: new Date(now() - 2 * HOUR).toISOString(),
        })),
      ]),
    ),
    worktreeInitScript: forRepo(real.worktreeInitScript, async (repo) =>
      ok({
        path: `${REPO_PATH[repo]}/.santree/init.sh`,
        exists: true,
        executable: true,
        content:
          "#!/bin/sh\nset -e\nln -sf ../../../.env .env\npnpm install --frozen-lockfile --prefer-offline\npnpm db:create-from-template\npnpm db:migrate\npnpm codegen\n",
      }),
    ),

    getSetting: async (scope, key) => {
      const override = scope === "app" ? settingOverride(key) : undefined;
      return override === undefined ? real.getSetting(scope, key) : ok(override);
    },
    resolveSetting: async (repo, key) => {
      const override = settingOverride(key);
      return override === undefined ? real.resolveSetting(repo, key) : ok(override);
    },

    // ── Trackers ───────────────────────────────────────────────────────────
    jiraSites: async () => ok([]),
    jiraAuthStatus: async () =>
      ok({ authenticated: false, siteName: null, siteUrl: null, cloudId: null, canWrite: false }),
    linearAuthStatus: async () =>
      ok({
        authenticated: true,
        orgSlug: LINEAR_ORG.slug,
        org: LINEAR_ORG.name,
        canWrite: true,
        via: "OAuth",
      }),
    linearOrgs: async () =>
      ok([{ slug: LINEAR_ORG.slug, name: LINEAR_ORG.name, canWrite: true, via: "OAuth" }]),
    linearApiBudget: async () =>
      ok([
        {
          slug: LINEAR_ORG.slug,
          name: LINEAR_ORG.name,
          windows: [
            {
              kind: "Complexity",
              limit: 250_000,
              remaining: 228_900,
              resetsAtMs: now() + 38 * MIN,
            },
            { kind: "Requests", limit: 1_500, remaining: 1_441, resetsAtMs: now() + 38 * MIN },
          ],
          observedAtMs: now() - 2 * MIN,
        },
      ]),
    // The whole org, as Linear answers: a repo only scopes which org to read.
    linearListIssues: forRepo(real.linearListIssues, async () => ok(tasks())),
    taskNote: forRepo(real.taskNote, async () => ok(null)),
    setTaskNote: forRepo(real.setTaskNote, async () => ok(null)),
    triageDetail: async (repo, ticketId) => {
      const detail = ticketDetail(ticketId, now());
      return detail ? ok(detail) : real.triageDetail(repo, ticketId);
    },
    listTriageTickets: forRepo(real.listTriageTickets, async (repo) =>
      ok(triageTickets(repo, now())),
    ),
    triageSchedule: forRepo(real.triageSchedule, async (repo) => ok(triageSchedule(repo, now()))),
    linearTeams: forRepo(real.linearTeams, async (repo) => ok(linearTeams(repo))),
    triageSnooze: forRepo(real.triageSnooze, async () => ok(null)),
    triageSetState: forRepo(real.triageSetState, async () => ok(null)),
    triageAddComment: forRepo(real.triageAddComment, async () => ok(null)),
    startedInvestigations: forRepo(real.startedInvestigations, async () => ok([])),
    workPrompt: forRepo(real.workPrompt, async (repo, issueId) =>
      ok(`${REPO_PATH[repo]}/.santree/prompts/work-${issueId}.md`),
    ),
    investigatePrompt: forRepo(real.investigatePrompt, async (repo, issueId) =>
      ok(`${REPO_PATH[repo]}/.santree/prompts/investigate-${issueId}.md`),
    ),

    // ── Worktrees ──────────────────────────────────────────────────────────
    worktrees: forRepo(real.worktrees, async (repo) => ok(worktrees(repo))),
    baseWorktree: forRepo(real.baseWorktree, async (repo) => ok(baseWorktree(repo))),
    createWorktree: forRepo(
      real.createWorktree,
      async (repo, issueId, title, _launch, base, agent) => {
        // Registered before the wait, so whichever create of a batch answers
        // first refetches the list with all of them: every launch turns real,
        // runs setup and starts its agent together, as a bulk launch does.
        let w = findWt(repo, issueId);
        if (!w) {
          w = newWt({
            id: issueId,
            repo,
            title: title || (ticketSeed(issueId)?.title ?? issueId),
            agent: agent ?? "Claude",
            baseBranch: base ?? "main",
            setupRan: false,
          });
          worktreesState.push(w);
        }
        await sleep(900);
        return ok(toWorktree(w));
      },
    ),
    removeWorktree: forRepo(real.removeWorktree, async (repo, issueId) => {
      const i = worktreesState.findIndex((w) => w.repo === repo && w.id === issueId);
      if (i !== -1) worktreesState.splice(i, 1);
      return ok(null);
    }),
    runWorktreeSetupStreamed: forRepo(
      real.runWorktreeSetupStreamed,
      async (repo, issueId, onEvent) => {
        const w = findWt(repo, issueId);
        for (const chunk of setupChunks(issueId, w?.branch ?? "main")) {
          await sleep(chunk.afterMs);
          onEvent.onmessage({ type: "chunk", text: chunk.text });
        }
        if (w) w.setupRan = true;
        onEvent.onmessage({ type: "done", ok: true });
        return ok(null);
      },
    ),
    cancelWorktreeSetup: forRepo(real.cancelWorktreeSetup, async () => ok(true)),
    resizeWorktreeSetup: forRepo(real.resizeWorktreeSetup, async () => ok(true)),
    setWorktreeTitle: forRepo(real.setWorktreeTitle, async (repo, issueId, title) => {
      const w = findWt(repo, issueId);
      if (w) w.title = title;
      return ok(null);
    }),

    worktreePrs: forRepo(real.worktreePrs, async (repo) =>
      ok(
        [...worktreePrNumbers.entries()]
          .filter(([, pr]) => pr.repo === repo)
          .map(
            ([issueId, pr]): WorktreePr => ({
              issueId,
              repo: pr.repo,
              number: pr.number,
              url: prUrl(pr.repo, pr.number),
              state: "Open",
            }),
          ),
      ),
    ),
    worktreeStatus: forRepo(real.worktreeStatus, async (repo, issueId) =>
      ok(changedFiles(findWt(repo, issueId)?.working ?? [])),
    ),
    worktreeBranchChanges: forRepo(real.worktreeBranchChanges, async (repo, issueId) =>
      ok(branchChanges(findWt(repo, issueId)?.committed ?? [])),
    ),
    worktreeFiles: forRepo(real.worktreeFiles, async (repo) =>
      ok(repo === DRIVER ? [] : PLATFORM_FILES),
    ),
    worktreeFileDiff: forRepo(real.worktreeFileDiff, async (repo, issueId, path) => {
      const f = findWt(repo, issueId)?.working.find((x) => x.path === path);
      return ok(f ? gitDiff(f.path, f.oldText, f.newText) : "");
    }),
    worktreeBranchFileDiff: forRepo(real.worktreeBranchFileDiff, async (repo, issueId, path) => {
      const f = findWt(repo, issueId)?.committed.find((x) => x.path === path);
      return ok(f ? gitDiff(f.path, f.oldText, f.newText) : "");
    }),
    worktreeFileSource: forRepo(real.worktreeFileSource, async (repo, issueId, path) => {
      const w = findWt(repo, issueId);
      const f =
        w?.working.find((x) => x.path === path) ?? w?.committed.find((x) => x.path === path);
      return ok(f ? { oldText: f.oldText, newText: f.newText } : { oldText: "", newText: "" });
    }),
    worktreeSessions: forRepo(real.worktreeSessions, async (repo, issueId) =>
      ok(worktreeSessions(repo, issueId, now())),
    ),
    worktreeSessionDetail: forRepo(real.worktreeSessionDetail, async (repo, issueId) =>
      ok({
        firstPrompt: `Work on ${issueId}.`,
        firstPromptTruncated: false,
        recentTurns: [],
        cwd: REPO_PATH[repo],
      }),
    ),
    worktreeSessionSubagents: forRepo(real.worktreeSessionSubagents, async () => ok([])),
    worktreeHasTranscripts: forRepo(real.worktreeHasTranscripts, async () => ok(true)),

    // ── Staging and committing ─────────────────────────────────────────────
    stagePath: forRepo(real.stagePath, async (repo, issueId, path) => {
      await sleep(60);
      const w = findWt(repo, issueId);
      if (w) setStaged(w, path, true);
      return ok(null);
    }),
    unstagePath: forRepo(real.unstagePath, async (repo, issueId, path) => {
      await sleep(60);
      const w = findWt(repo, issueId);
      if (w) setStaged(w, path, false);
      return ok(null);
    }),
    stageAllPaths: forRepo(real.stageAllPaths, async (repo, issueId) => {
      await sleep(80);
      const w = findWt(repo, issueId);
      if (w) setStaged(w, null, true);
      return ok(null);
    }),
    unstageAllPaths: forRepo(real.unstageAllPaths, async (repo, issueId) => {
      await sleep(80);
      const w = findWt(repo, issueId);
      if (w) setStaged(w, null, false);
      return ok(null);
    }),
    discardPath: forRepo(real.discardPath, async (repo, issueId, path) => {
      const w = findWt(repo, issueId);
      if (w) w.working = w.working.filter((f) => f.path !== path);
      return ok(null);
    }),
    commitDraft: forRepo(real.commitDraft, async (repo, issueId) =>
      ok(commitDrafts.get(`${repo}:${issueId}`) ?? null),
    ),
    setCommitDraft: forRepo(real.setCommitDraft, async (repo, issueId, message) => {
      const key = `${repo}:${issueId}`;
      if (message.trim()) commitDrafts.set(key, message);
      else commitDrafts.delete(key);
      return ok(null);
    }),
    // Almost instant: long enough for the spinner to register, never long
    // enough to cost the recording its seconds.
    commitMessage: forRepo(real.commitMessage, async (_repo, issueId) => {
      await sleep(600);
      return ok(commitMessageFor(issueId));
    }),
    commitWorktree: forRepo(real.commitWorktree, async (repo, issueId, _message, stageAll) => {
      await sleep(650);
      const w = findWt(repo, issueId);
      if (!w) return ok(null);
      const going = w.working.filter((f) => stageAll || f.staged);
      if (going.length === 0) return err("nothing to commit");
      w.working = w.working.filter((f) => !going.includes(f));
      for (const f of going) {
        const prev = w.committed.find((c) => c.path === f.path);
        if (prev) prev.newText = f.newText;
        else w.committed.push({ path: f.path, oldText: f.oldText, newText: f.newText });
      }
      w.ahead += 1;
      w.unpushed += 1;
      commitDrafts.delete(`${w.repo}:${w.id}`);
      worktreeMoved(w.repo, w.id);
      return ok(null);
    }),
    pushWorktree: forRepo(real.pushWorktree, async (repo, issueId) => {
      await sleep(1_100);
      const w = findWt(repo, issueId);
      if (!w) return ok(null);
      w.unpushed = 0;
      worktreeMoved(w.repo, w.id);
      // Pushing the queue run's fixes is what turns the hero PR's CI around.
      if (w.id === HERO && heroPr && w.committed.some((f) => f.newText.includes("withLease"))) {
        pushHeroFix(now());
        refreshPolled("prDetailPrefix", "prSummaryPrefix", "reviewsPrefix");
      }
      return ok(null);
    }),
    pullWorktree: forRepo(real.pullWorktree, async () => ok("Already up to date.")),
    updateBaseBranch: forRepo(real.updateBaseBranch, async () => ok("Already up to date.")),

    // ── Opening a PR ───────────────────────────────────────────────────────
    prDraft: forRepo(real.prDraft, async (repo, issueId, fill) => {
      const w = findWt(repo, issueId);
      const title = `[${issueId}] ${ticketSeed(issueId)?.title ?? w?.title ?? issueId}`;
      if (!fill) return ok({ title, body: "", baseBranch: w?.baseBranch ?? "main" });
      await sleep(850);
      return ok({
        title,
        body:
          PR_BODIES[issueId] ??
          `Implements ${issueId}: ${ticketSeed(issueId)?.title ?? ""}.\n\nCloses ${issueId}`,
        baseBranch: w?.baseBranch ?? "main",
      });
    }),
    prReviewers: forRepo(real.prReviewers, async () =>
      ok(
        [PEOPLE.daniel, PEOPLE.maya, PEOPLE.priya, PEOPLE.lucia].map((name) => ({
          kind: "User",
          name: LOGIN[name],
          avatarUrl: avatar(name),
        })),
      ),
    ),
    createPullRequest: forRepo(
      real.createPullRequest,
      async (repo, issueId, title, body, draft) => {
        await sleep(1_300);
        const w = findWt(repo, issueId);
        const number = takePrNumber();
        openedPrs.push({
          repo,
          number,
          worktreeId: issueId,
          title,
          body,
          headRef: w?.branch ?? "",
          baseRef: w?.baseBranch ?? "main",
          files: w?.committed ?? [],
          openedAt: now(),
          draft,
        });
        worktreePrNumbers.set(issueId, { repo, number });
        // The hero's PR starts its clock: CI and the coworkers arrive on their own.
        if (issueId === HERO) openHeroPr(number, now());
        if (w) w.unpushed = 0;
        refreshPolled("reviewsPrefix");
        return ok({ number, url: prUrl(repo, number) });
      },
    ),

    // ── Tabs and agents ────────────────────────────────────────────────────
    listWorktreeTabs: forRepo(real.listWorktreeTabs, async (repo) => {
      const ids = new Set(worktrees(repo).map((w) => w.id));
      ids.add("__base__");
      return ok(tabs.filter((t) => ids.has(t.worktreeId)));
    }),
    addWorktreeTab: forRepo(
      real.addWorktreeTab,
      async (_repo, worktreeId, id, kind, agentKind, title, pr) => {
        tabs.push({ id, worktreeId, kind, agentKind, title, pr });
        return ok(null);
      },
    ),
    renameWorktreeTab: forRepo(real.renameWorktreeTab, async (_repo, id, title) => {
      const t = tabs.find((x) => x.id === id);
      if (t) t.title = title;
      return ok(null);
    }),
    removeWorktreeTab: forRepo(real.removeWorktreeTab, async (_repo, id) => {
      const i = tabs.findIndex((x) => x.id === id);
      if (i !== -1) tabs.splice(i, 1);
      return ok(null);
    }),
    worktreeTabLaunch: forRepo(real.worktreeTabLaunch, async (repo, id) => {
      const t = tabs.find((x) => x.id === id);
      if (!t || (t.kind !== "aiReview" && t.kind !== "fixCi")) return ok(null);
      const dir = `${REPO_PATH[repo]}/.santree`;
      return ok({
        settingsPath: `${dir}/review-settings.json`,
        mcpConfigPath: `${dir}/review-mcp.json`,
      });
    }),
    agentSession: forRepo(real.agentSession, async (_repo, _termKey, _cwd, _allowFresh, agent) =>
      ok({
        type: "fresh",
        agentKind: agent,
        executable: agent === "Codex" ? "codex" : "claude",
        sessionId: null,
        launchFlags: "",
      }),
    ),
    sessionProviders: forRepo(real.sessionProviders, async (_repo, termKey) => {
      const t = tabs.find((x) => termKey.endsWith(`:tab:${x.id}`));
      return ok(t?.agentKind ? [t.agentKind] : []);
    }),
    resumeWorktreeSession: forRepo(real.resumeWorktreeSession, async () => ok(null)),

    // Demo rows, plus the real ones for Daedalus projects so those stay live.
    sessionStates: async () => {
      const daedalus = new Set((await realRepos()).map((r) => r.name));
      const own = (await dataOr(real.sessionStates(), [])).filter(
        (s) => s.repo && daedalus.has(s.repo),
      );
      return ok([...sessionStates(now()), ...own]);
    },
    agentProcesses: async () =>
      ok([...(await dataOr(real.agentProcesses(), [])), ...fakeAgentProcesses()]),

    // ── GitHub ─────────────────────────────────────────────────────────────
    reviews: async () => {
      const t = now();
      const mine = [
        ...PR_SEEDS.filter((p) => p.section === "mine").map((p) =>
          prSummaryOf(p.repo, p.number, t),
        ),
        ...openedPrs.map((p) => prSummaryOf(p.repo, p.number, t)),
      ].filter((p) => p !== null);
      const others = PR_SEEDS.filter((p) => p.section !== "mine").map((p) => toReviewPr(p, T0));
      return ok(reviewInbox(mine, others));
    },
    githubViewerLogin: async () => ok(ME_LOGIN),
    prSummary: forGithub(real.prSummary, async (owner, name, number) =>
      ok(prSummaryOf(`${owner}/${name}`, number, now())),
    ),
    prDetail: forGithub(real.prDetail, async (owner, name, number) => {
      const detail = prDetailOf(`${owner}/${name}`, number, now());
      return detail ? ok(detail) : err(`no pull request #${number} in ${owner}/${name}`);
    }),
    prRepoLabels: forGithub(real.prRepoLabels, async () => ok(DEMO_LABELS)),
    setPrLabels: forGithub(real.setPrLabels, async (_owner, _name, _number, labels) =>
      ok(DEMO_LABELS.filter((l) => labels.includes(l.name))),
    ),
    prTickets: async (_repo, ids) => ok(prTickets(ids)),
    mergeQueue: forRepo(real.mergeQueue, async (repo) => {
      const t = now();
      const opened = heroPr ? openedPrs.find((p) => p.number === heroPr?.number) : undefined;
      const queued =
        heroPr && opened && heroDecision(heroPr, t) === "Approved"
          ? { number: heroPr.number, title: opened.title, enqueuedAt: t - 20 * SEC }
          : null;
      return ok(mergeQueue(repo, t, repo === HERO_REPO ? queued : null));
    }),
    prFileSource: forGithub(
      real.prFileSource,
      async (_owner, _name, _base, _head, _old, newPath) => {
        const files = heroPr ? heroPrFiles(heroPr) : [];
        const f = files.find((x) => x.path === newPath);
        return ok(f ? { oldText: f.oldText, newText: f.newText } : { oldText: "", newText: "" });
      },
    ),
    prCheckLog: forGithub(real.prCheckLog, async (_owner, _name, jobId) =>
      ok(
        jobId !== null && heroJobLog(jobId) === "typecheck"
          ? {
              blocks: [
                { kind: "line", text: "$ pnpm typecheck", level: "Command" },
                {
                  kind: "line",
                  text: "src/webhooks/retryWorker.ts(30,20): error TS2339: Property 'leaseUntil' does not exist on type 'DeliveryRow'.",
                  level: "Error",
                },
                {
                  kind: "line",
                  text: "Found 1 error in src/webhooks/retryWorker.ts:30",
                  level: "Warning",
                },
                {
                  kind: "line",
                  text: "ELIFECYCLE  Command failed with exit code 2.",
                  level: "Error",
                },
              ],
              truncated: false,
            }
          : {
              blocks: [
                { kind: "line", text: "$ pnpm vitest run", level: "Command" },
                {
                  kind: "group",
                  title: "src/webhooks/retryWorker.test.ts (shard 2/3)",
                  lines: [
                    {
                      text: " ✓ retry worker › delivers once to an endpoint slower than the poll interval",
                      level: "Normal",
                    },
                    {
                      text: " ✗ retry worker › delivers once to an endpoint slower than the lease",
                      level: "Error",
                    },
                    {
                      text: "   AssertionError: expected [ …(2) ] to have a length of 1 but got 2",
                      level: "Error",
                    },
                    {
                      text: "   at src/webhooks/retryWorker.test.ts:21:31",
                      level: "Error",
                    },
                    { text: " ✓ retry worker › sends an Idempotency-Key", level: "Normal" },
                  ],
                },
                {
                  kind: "line",
                  text: "Test Files  1 failed | 71 passed (72)",
                  level: "Warning",
                },
                {
                  kind: "line",
                  text: "     Tests  1 failed | 511 passed (512)",
                  level: "Warning",
                },
                {
                  kind: "line",
                  text: "ELIFECYCLE  Test failed. See above for more details.",
                  level: "Error",
                },
              ],
              truncated: false,
            },
      ),
    ),
    reviewedFiles: forRepo(real.reviewedFiles, async () => ok({ source: "local", files: [] })),
    setFileReviewed: forRepo(real.setFileReviewed, async () => ok(null)),
    replyToPrThread: forRepo(real.replyToPrThread, async () => ok(null)),
    addPrComment: forRepo(real.addPrComment, async () => ok(null)),
    setPrThreadResolved: async (threadId, resolved) =>
      threadId.startsWith("PRRT_hero") ? ok(null) : real.setPrThreadResolved(threadId, resolved),
    reviewCheckout: forRepo(real.reviewCheckout, async () => ok(null)),
    reviewWorkspace: forRepo(real.reviewWorkspace, async () => ok(null)),
    githubApiBudget: async () => ({
      windows: [
        { kind: "Rest", limit: 5_000, remaining: 4_812, resetsAtMs: now() + 41 * MIN },
        { kind: "GraphQl", limit: 5_000, remaining: 4_655, resetsAtMs: now() + 41 * MIN },
        { kind: "Search", limit: 30, remaining: 30, resetsAtMs: now() + MIN },
      ],
    }),

    // ── The AI review and the work queue ───────────────────────────────────
    aiReviewLaunch: forRepo(real.aiReviewLaunch, async (repo, target) => {
      await sleep(600);
      const dir = `${REPO_PATH[repo]}/.santree`;
      return ok({
        promptPath: `${dir}/review-${target.number}.md`,
        settingsPath: `${dir}/review-settings.json`,
        mcpConfigPath: `${dir}/review-mcp.json`,
      });
    }),
    reviewFixLaunch: forRepo(real.reviewFixLaunch, async (repo, target) => {
      const open = (workItems.get(prKey(target.prRepo, target.number)) ?? []).filter(
        (i) => !i.done,
      );
      if (open.length === 0) return err("there are no open review improvements to fix");
      await sleep(500);
      const dir = `${REPO_PATH[repo]}/.santree`;
      return ok({
        promptPath: `${dir}/fix-${target.number}.md`,
        settingsPath: `${dir}/review-settings.json`,
        mcpConfigPath: `${dir}/review-mcp.json`,
      });
    }),
    reviewDrafts: forRepo(real.reviewDrafts, async (prRepo, number) =>
      ok(drafts.get(prKey(prRepo, number)) ?? []),
    ),
    prReviewBrief: forRepo(real.prReviewBrief, async (prRepo, number) =>
      ok(briefs.get(prKey(prRepo, number)) ?? null),
    ),
    updateReviewDraft: async (id, body, suggestion) => {
      for (const list of drafts.values()) {
        const d = list.find((x) => x.id === id);
        if (d) {
          d.body = body;
          d.suggestion = suggestion;
          d.updatedAtMs = now();
          return ok(d);
        }
      }
      return real.updateReviewDraft(id, body, suggestion);
    },
    deleteReviewDraft: async (id) => {
      for (const [key, list] of drafts) {
        if (list.some((x) => x.id === id)) {
          drafts.set(
            key,
            list.filter((x) => x.id !== id),
          );
          return ok(null);
        }
      }
      return real.deleteReviewDraft(id);
    },
    clearReviewDrafts: forRepo(real.clearReviewDrafts, async (prRepo, number) => {
      const key = prKey(prRepo, number);
      const n = drafts.get(key)?.length ?? 0;
      drafts.delete(key);
      return ok(n);
    }),
    reviewWorkItems: forRepo(real.reviewWorkItems, async (prRepo, number) =>
      ok(workItems.get(prKey(prRepo, number)) ?? []),
    ),
    addReviewWorkItem: forRepo(real.addReviewWorkItem, async (prRepo, number, item) => {
      const key = prKey(prRepo, number);
      const row: ReviewWorkItem = {
        ...item,
        prRepo,
        prNumber: number,
        done: false,
        createdAtMs: now(),
        updatedAtMs: now(),
      };
      workItems.set(key, [...(workItems.get(key) ?? []), row]);
      return ok(row);
    }),
    updateReviewWorkItem: forRepo(
      real.updateReviewWorkItem,
      async (prRepo, number, id, body, done) => {
        const item = (workItems.get(prKey(prRepo, number)) ?? []).find((x) => x.id === id);
        if (!item) return err("no such work item");
        item.body = body;
        item.done = done;
        item.updatedAtMs = now();
        return ok(item);
      },
    ),
    deleteReviewWorkItem: forRepo(real.deleteReviewWorkItem, async (prRepo, number, id) => {
      const key = prKey(prRepo, number);
      workItems.set(
        key,
        (workItems.get(key) ?? []).filter((x) => x.id !== id),
      );
      return ok(null);
    }),
    closeReviewSession: forRepo(real.closeReviewSession, async () => ok(null)),

    // ── Usage ──────────────────────────────────────────────────────────────
    sessionUsageLive: async () => ok([]),
    claudeRateLimits: async () =>
      ok([
        {
          window: "five_hour",
          usedPct: 23,
          resetsAtMs: now() + 2 * HOUR + 47 * MIN,
          updatedAtMs: now() - MIN,
        },
        {
          window: "seven_day",
          usedPct: 41,
          resetsAtMs: now() + 4 * DAY + 6 * HOUR,
          updatedAtMs: now() - MIN,
        },
      ]),
    codexRateLimits: async () =>
      ok({
        plan: "Pro",
        primary: {
          usedPercent: 18,
          windowMinutes: 300,
          resetsAt: Math.floor((now() + 3 * HOUR) / 1000),
        },
        secondary: {
          usedPercent: 37,
          windowMinutes: 10_080,
          resetsAt: Math.floor((now() + 5 * DAY) / 1000),
        },
      }),

    // ── Terminals ──────────────────────────────────────────────────────────
    // Owned by where they run: a pane in a demo checkout is scripted, anything
    // else (Daedalus, a real shell) is a real PTY.
    terminalOpen: async (opts, onOutput, onLink) =>
      isDemoPath(opts.cwd) && locate(opts.cwd)
        ? ok(openFake(opts, onOutput))
        : real.terminalOpen(opts, onOutput, onLink),
    terminalAttach: forPty(real.terminalAttach, async (id, _anchor, onOutput) =>
      ok(attachFake(id, onOutput)),
    ),
    terminalResize: forPty(real.terminalResize, async (id, cols, rows) => {
      resizeFake(id, cols, rows);
      return ok(null);
    }),
    terminalDetach: forPty(real.terminalDetach, async (id) => {
      detachFake(id);
      return ok(null);
    }),
    terminalWrite: forPty(real.terminalWrite, async () => ok(null)),
    terminalSeed: forPty(real.terminalSeed, async () => ok(null)),
    terminalClose: forPty(real.terminalClose, async (id) => {
      closeFake(id);
      return ok(null);
    }),
    terminalSessions: async () => {
      const own = await real.terminalSessions();
      return own.status === "ok" ? ok([...own.data, ...fakeSessions()]) : own;
    },
  };
}
