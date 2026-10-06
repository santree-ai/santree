/**
 * The GitHub half of the demo world: my PRs (one in the merge queue, one
 * stacked on it, one with red CI and review comments), the coworkers' PRs
 * waiting on me (a stack of three among them), and a busy merge queue.
 *
 * Static seeds live here; what the demo changes (a new PR, the review fixes
 * landing) is read from `state.ts` through the arguments.
 */
import type {
  MergeQueueView,
  PrCheck,
  PrComment,
  PrCommit,
  PrDetail,
  PrFile,
  ReviewInbox,
  ReviewPr,
  TicketRef,
} from "../../../bindings";
import type { SourceFile } from "./code";
import {
  avatar,
  branchFor,
  DAY,
  DRIVER,
  HOUR,
  INFRA,
  iso,
  ME,
  MIN,
  PEOPLE,
  PLATFORM,
  SEC,
  ticketSeed,
} from "./company";
import { diffOf } from "./diff";

export interface PrSeed {
  repo: string;
  number: number;
  title: string;
  author: string;
  headRef: string;
  /** The branch it merges into; another PR's head makes it stacked. */
  baseRef: string;
  createdAgo: number;
  waitingAgo: number;
  pushedAgo: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  checks: ReviewPr["checks"];
  decision: ReviewPr["reviewDecision"];
  isDraft?: boolean;
  inQueue?: boolean;
  section: "mine" | "requested" | "team";
  /** The worktree it belongs to, for my own. */
  worktreeId?: string;
  body: string;
}

const branchOf = (id: string) => branchFor(id, ticketSeed(id)?.title ?? id);

export const BRANCH = {
  "PLAT-401": branchOf("PLAT-401"),
  "PLAT-402": branchOf("PLAT-402"),
  "PLAT-404": branchOf("PLAT-404"),
  "PLAT-421": branchOf("PLAT-421"),
  "DRV-91": branchOf("DRV-91"),
} as const;

const LANE_1 = "mayachen/lane-history-table";
const LANE_2 = "mayachen/lane-history-aggregation";
const LANE_3 = "mayachen/lane-history-eta";

export const PR_SEEDS: PrSeed[] = [
  // ── Mine ───────────────────────────────────────────────────────────────────
  {
    repo: PLATFORM,
    number: 1279,
    title: "[PLAT-401] Ingest carrier scan events into the event bus",
    author: ME,
    headRef: BRANCH["PLAT-401"],
    baseRef: "main",
    createdAgo: 3 * DAY,
    waitingAgo: 2 * DAY,
    pushedAgo: 5 * HOUR,
    additions: 486,
    deletions: 52,
    changedFiles: 14,
    comments: 6,
    checks: "Success",
    decision: "Approved",
    inQueue: true,
    section: "mine",
    worktreeId: "PLAT-401",
    body: "One consumer per carrier adapter, publishing to `scan-events` keyed by tracking number. Idempotent on `(carrier, scan_id)`; unparseable payloads go to `scan-events.dlq`.\n\nCloses PLAT-401.",
  },
  {
    repo: PLATFORM,
    number: 1284,
    title: "[PLAT-402] Normalize scan events to a canonical schema",
    author: ME,
    headRef: BRANCH["PLAT-402"],
    baseRef: BRANCH["PLAT-401"],
    createdAgo: DAY,
    waitingAgo: 20 * HOUR,
    pushedAgo: 3 * HOUR,
    additions: 318,
    deletions: 41,
    changedFiles: 9,
    comments: 2,
    checks: "Success",
    decision: "ReviewRequired",
    section: "mine",
    worktreeId: "PLAT-402",
    body: "Stacked on #1279.\n\nMaps UPS, FedEx, USPS and DHL status codes onto `ScanEvent`. Unknown codes become `in_transit` and keep the raw code in `carrier_status`.\n\nCloses PLAT-402.",
  },
  // ── Waiting on me ──────────────────────────────────────────────────────────
  {
    repo: PLATFORM,
    number: 1281,
    title: "Lane-time history: table and backfill",
    author: PEOPLE.maya,
    headRef: LANE_1,
    baseRef: "main",
    createdAgo: 2 * DAY,
    waitingAgo: 30 * HOUR,
    pushedAgo: 26 * HOUR,
    additions: 212,
    deletions: 4,
    changedFiles: 5,
    comments: 2,
    checks: "Success",
    decision: "ReviewRequired",
    section: "requested",
    body: "First of three for the ETA model (PLAT-405). Stores p50/p90 transit time per origin hub → destination hub → service level.",
  },
  {
    repo: PLATFORM,
    number: 1285,
    title: "Lane-time history: nightly aggregation job",
    author: PEOPLE.maya,
    headRef: LANE_2,
    baseRef: LANE_1,
    createdAgo: 30 * HOUR,
    waitingAgo: 26 * HOUR,
    pushedAgo: 20 * HOUR,
    additions: 164,
    deletions: 12,
    changedFiles: 4,
    comments: 0,
    checks: "Success",
    decision: "ReviewRequired",
    section: "requested",
    body: "Stacked on #1281. Recomputes the percentiles nightly from the last 60 days of delivered shipments.",
  },
  {
    repo: PLATFORM,
    number: 1290,
    title: "Lane-time history: expose to the ETA service",
    author: PEOPLE.maya,
    headRef: LANE_3,
    baseRef: LANE_2,
    createdAgo: 9 * HOUR,
    waitingAgo: 8 * HOUR,
    pushedAgo: 2 * HOUR,
    additions: 97,
    deletions: 18,
    changedFiles: 3,
    comments: 1,
    checks: "Pending",
    decision: "ReviewRequired",
    section: "requested",
    body: "Stacked on #1285. `LaneHistory.lookup()` with a 5-minute in-process cache.",
  },
  {
    repo: DRIVER,
    number: 214,
    title: "[DRV-88] Capture signature on delivery",
    author: PEOPLE.jonas,
    headRef: "jlindqvist/drv-88-capture-signature-on-delivery",
    baseRef: "main",
    createdAgo: DAY,
    waitingAgo: 22 * HOUR,
    pushedAgo: 4 * HOUR,
    additions: 241,
    deletions: 16,
    changedFiles: 7,
    comments: 3,
    checks: "Success",
    decision: "ReviewRequired",
    section: "requested",
    body: "Signature pad on the delivery screen for parcels flagged `signature_required`. Uploaded with the proof-of-delivery photo.",
  },
  {
    repo: INFRA,
    number: 88,
    title: "[INFRA-57] Redis cluster: three shards, one replica per AZ",
    author: PEOPLE.tom,
    headRef: "tbecker/infra-57-redis-cluster",
    baseRef: "main",
    createdAgo: 6 * HOUR,
    waitingAgo: 5 * HOUR,
    pushedAgo: 90 * MIN,
    additions: 132,
    deletions: 38,
    changedFiles: 6,
    comments: 1,
    checks: "Failure",
    decision: "ReviewRequired",
    section: "requested",
    body: "Needed before PLAT-409 ships: the rate limiter makes Redis load-bearing for the API.",
  },
  {
    repo: PLATFORM,
    number: 1289,
    title: "SDK generator: surface RateLimit headers",
    author: PEOPLE.ethan,
    headRef: "ebrooks/sdk-ratelimit-headers",
    baseRef: "main",
    createdAgo: 7 * HOUR,
    waitingAgo: 7 * HOUR,
    pushedAgo: 7 * HOUR,
    additions: 58,
    deletions: 6,
    changedFiles: 3,
    comments: 0,
    checks: "Success",
    decision: "ReviewRequired",
    section: "team",
    body: "Exposes `RateLimit-*` on every SDK response and retries 429s after `Retry-After`.",
  },
  {
    repo: PLATFORM,
    number: 1291,
    title: "Webhooks: delivery log in the dashboard",
    author: PEOPLE.aisha,
    headRef: "aishab/webhook-delivery-log",
    baseRef: "main",
    createdAgo: 4 * HOUR,
    waitingAgo: 4 * HOUR,
    pushedAgo: 3 * HOUR,
    additions: 388,
    deletions: 21,
    changedFiles: 11,
    comments: 0,
    checks: "Success",
    decision: "ReviewRequired",
    isDraft: true,
    section: "team",
    body: "Last 30 days of deliveries per endpoint, with the response body and a redeliver button.",
  },
];

// ── Shared builders ──────────────────────────────────────────────────────────

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
export const shaOf = (seed: string) => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (
    hex(h) +
    hex(Math.imul(h, 2654435761)) +
    hex(h ^ 0x5bd1e995) +
    hex(~h) +
    hex(h * 7)
  ).slice(0, 40);
};

export const prUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

/** Things the demo changes on a PR, overlaid on its seed. */
export interface PrOverlay {
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  checks?: ReviewPr["checks"];
  decision?: ReviewPr["reviewDecision"];
  headSha?: string;
  pushedAt?: number;
  aiDraftCount?: number;
}

export function toReviewPr(seed: PrSeed, now: number, o: PrOverlay = {}): ReviewPr {
  return {
    id: `PR_${seed.repo.replace("/", "_")}_${seed.number}`,
    number: seed.number,
    title: seed.title,
    url: prUrl(seed.repo, seed.number),
    repo: seed.repo,
    project: seed.repo,
    headRef: seed.headRef,
    headRefId: `REF_${shaOf(`${seed.repo}:${seed.headRef}`).slice(0, 12)}`,
    baseRef: seed.baseRef,
    baseRefId: `REF_${shaOf(`${seed.repo}:${seed.baseRef}`).slice(0, 12)}`,
    headSha: o.headSha ?? shaOf(`${seed.repo}#${seed.number}`),
    author: seed.author,
    authorAvatarUrl: avatar(seed.author),
    state: "Open",
    isDraft: seed.isDraft ?? false,
    reviewDecision: o.decision ?? seed.decision,
    checks: o.checks ?? seed.checks,
    isInMergeQueue: seed.inQueue ?? false,
    additions: o.additions ?? seed.additions,
    deletions: o.deletions ?? seed.deletions,
    changedFiles: o.changedFiles ?? seed.changedFiles,
    commentCount: seed.comments,
    aiDraftCount: o.aiDraftCount ?? 0,
    reviewers:
      seed.section === "team"
        ? [{ kind: "Team", name: "platform", avatarUrl: avatar("Platform") }]
        : seed.section === "requested"
          ? [{ kind: "User", name: ME, avatarUrl: avatar(ME) }]
          : [
              { kind: "User", name: PEOPLE.daniel, avatarUrl: avatar(PEOPLE.daniel) },
              { kind: "User", name: PEOPLE.maya, avatarUrl: avatar(PEOPLE.maya) },
            ],
    updatedAt: iso(o.pushedAt ?? now - seed.pushedAgo),
    createdAt: iso(now - seed.createdAgo),
    waitingSince: iso(now - seed.waitingAgo),
    headCommittedAt: iso(o.pushedAt ?? now - seed.pushedAgo),
    viewerReview: null,
  };
}

export const comment = (
  author: string,
  body: string,
  createdAt: string,
  kind: PrComment["kind"] = "Issue",
  path: string | null = null,
  reviewState: PrComment["reviewState"] = null,
): PrComment => ({
  author,
  authorAvatarUrl: avatar(author),
  body,
  createdAt,
  kind,
  reviewState: kind === "Review" ? (reviewState ?? "Commented") : null,
  path,
  isPending: false,
  isBot: false,
});

export function prFiles(files: SourceFile[]): PrFile[] {
  return files.map((f) => {
    const d = diffOf(f.oldText, f.newText);
    return {
      path: f.path,
      previousPath: null,
      status: f.oldText === "" ? "added" : "modified",
      additions: d.additions,
      deletions: d.deletions,
      patch: d.patch,
      sha: shaOf(f.path + f.newText.length),
    };
  });
}

/** The 1-based line of the first line containing `needle` in `text`. */
export function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  return i === -1 ? 1 : i + 1;
}

export const check = (
  repo: string,
  name: string,
  status: PrCheck["status"],
  now: number,
  extra: Partial<PrCheck> = {},
): PrCheck => ({
  name,
  status,
  description:
    status === "Success"
      ? `Successful in ${2 + (name.length % 4)}m ${10 + name.length * 3}s`
      : status === "Failure"
        ? "Failing after 3m 41s"
        : status === "Pending"
          ? "In progress — started just now"
          : null,
  url: `https://github.com/${repo}/actions/runs/1180${name.length}`,
  steps: [],
  annotations: [],
  jobId: 33000 + name.length * 17,
  runId: 11800 + name.length,
  startedAt: iso(now - 6 * MIN),
  completedAt: status === "Pending" ? null : iso(now - 2 * MIN),
  ...extra,
});

const commitOf = (
  repo: string,
  author: string,
  headline: string,
  at: number,
  salt: string,
): PrCommit => {
  const oid = shaOf(`${repo}:${salt}:${headline}`);
  return {
    oid,
    abbreviatedOid: oid.slice(0, 7),
    messageHeadline: headline,
    messageBody: "",
    author,
    authorAvatarUrl: avatar(author),
    committedDate: iso(at),
    url: `https://github.com/${repo}/commit/${oid}`,
  };
};

// ── Every other PR's detail ──────────────────────────────────────────────────

export function genericDetail(seed: PrSeed, now: number): PrDetail {
  const fileCount = Math.min(seed.changedFiles, 6);
  const files: PrFile[] = Array.from({ length: fileCount }, (_, i) => {
    const path = [
      "src/tracking/lanes.ts",
      "src/tracking/lanes.test.ts",
      "db/migrations/0089_lane_history.sql",
      "src/jobs/nightly.ts",
      "src/tracking/eta.ts",
      "docs/tracking.md",
    ][i];
    const add = Math.round(seed.additions / fileCount);
    const del = Math.round(seed.deletions / fileCount);
    return {
      path,
      previousPath: null,
      status: "modified",
      additions: add,
      deletions: del,
      patch: null,
      sha: shaOf(path),
    };
  });
  const checksStatus = (name: string): PrCheck["status"] =>
    seed.checks === "Pending" && name === "test"
      ? "Pending"
      : seed.checks === "Failure" && name === "plan"
        ? "Failure"
        : "Success";
  const names =
    seed.repo === INFRA ? ["fmt", "validate", "plan"] : ["build", "lint", "typecheck", "test"];
  return {
    body: seed.body,
    attachments: [],
    labels: [],
    comments:
      seed.comments > 0
        ? [
            comment(
              PEOPLE.daniel,
              "Took a first pass — the shape looks right.",
              iso(now - seed.waitingAgo + HOUR),
            ),
          ]
        : [],
    threads: [],
    files,
    filesTruncated: false,
    commits: [
      commitOf(
        seed.repo,
        seed.author,
        seed.title.replace(/^\[[A-Z]+-\d+\] /, ""),
        now - seed.pushedAgo,
        `${seed.number}`,
      ),
    ],
    commitsTruncated: false,
    checks: names.map((n) => check(seed.repo, n, checksStatus(n), now)),
    baseSha: shaOf(`${seed.repo}:${seed.baseRef}`),
    headSha: shaOf(`${seed.repo}#${seed.number}`),
    pendingReviewId: null,
  };
}

/** A PR opened during the demo: just pushed, CI running then green. */
export function newPrDetail(
  repo: string,
  title: string,
  body: string,
  files: SourceFile[],
  openedAt: number,
  now: number,
): PrDetail {
  const settled = now - openedAt > 25 * SEC;
  return {
    body,
    attachments: [],
    labels: [],
    comments: [],
    threads: [],
    files: prFiles(files),
    filesTruncated: false,
    commits: [commitOf(repo, ME, title.replace(/^\[[A-Z]+-\d+\] /, ""), openedAt, "new")],
    commitsTruncated: false,
    checks: ["build", "lint", "typecheck", "test", "e2e"].map((n) =>
      check(repo, n, settled ? "Success" : "Pending", now, {
        startedAt: iso(openedAt + 2 * SEC),
        completedAt: settled ? iso(openedAt + 22 * SEC) : null,
      }),
    ),
    baseSha: shaOf(`${repo}:main`),
    headSha: shaOf(`${repo}:new:${title}`),
    pendingReviewId: null,
  };
}

// ── The inbox and the merge queue ────────────────────────────────────────────

export function reviewInbox(mine: ReviewPr[], others: ReviewPr[]): ReviewInbox {
  const bySection = (s: PrSeed["section"]) =>
    others.filter(
      (pr) => PR_SEEDS.find((p) => p.repo === pr.repo && p.number === pr.number)?.section === s,
    );
  return {
    mine,
    requested: bySection("requested"),
    teams: [{ org: "parcelwise", slug: "platform", name: "Platform", prs: bySection("team") }],
    projects: [
      { repo: PLATFORM, slug: PLATFORM },
      { repo: DRIVER, slug: DRIVER },
      { repo: INFRA, slug: INFRA },
    ],
    orgs: ["parcelwise"],
    githubConnected: true,
  };
}

export function mergeQueue(
  repo: string,
  now: number,
  hero: { number: number; title: string; enqueuedAt: number } | null = null,
): MergeQueueView {
  if (repo === INFRA) return infraQueue(now, hero);
  if (repo !== PLATFORM) return { repo, githubConnected: true, queue: null };
  const entry = (
    position: number,
    state: "Queued" | "AwaitingChecks" | "Mergeable",
    prNumber: number,
    prTitle: string,
    author: string,
    enqueuedAgo: number,
    estimatedSecs: number,
  ) => ({
    position,
    state,
    prNumber,
    prTitle,
    prUrl: prUrl(repo, prNumber),
    author,
    authorAvatarUrl: avatar(author),
    isMine: author === ME,
    enqueuedAt: iso(now - enqueuedAgo),
    estimatedSecs,
  });
  return {
    repo,
    githubConnected: true,
    queue: {
      repo,
      branch: "main",
      url: `https://github.com/${repo}/queue/main`,
      nextEstimatedSecs: 190,
      mergedLast30Days: 214,
      entries: [
        entry(
          1,
          "Mergeable",
          1268,
          "Upgrade the API runtime to Node 24",
          PEOPLE.ethan,
          41 * MIN,
          190,
        ),
        entry(
          2,
          "AwaitingChecks",
          1272,
          "Carrier status page component",
          PEOPLE.aisha,
          33 * MIN,
          610,
        ),
        entry(
          3,
          "AwaitingChecks",
          1279,
          "[PLAT-401] Ingest carrier scan events into the event bus",
          ME,
          26 * MIN,
          1_040,
        ),
        entry(4, "Queued", 1274, "Batch label PDF rendering", PEOPLE.tom, 21 * MIN, 1_480),
        entry(5, "Queued", 1276, "Shipper dashboard: API keys page", PEOPLE.lucia, 17 * MIN, 1_900),
        entry(
          6,
          "Queued",
          1280,
          "Retry carrier quotes once on 503",
          PEOPLE.daniel,
          12 * MIN,
          2_330,
        ),
        entry(7, "Queued", 1283, "Bump pino to 10", PEOPLE.jonas, 6 * MIN, 2_760),
        entry(
          8,
          "Queued",
          1286,
          "Label PDFs: embed the shipper logo",
          PEOPLE.priya,
          2 * MIN,
          3_180,
        ),
        // The hero joins at the back once it is approved.
        ...(hero
          ? [
              entry(
                9,
                "Queued",
                hero.number,
                hero.title,
                ME,
                Math.max(0, now - hero.enqueuedAt),
                3_600,
              ),
            ]
          : []),
      ],
    },
  };
}

/** Infra's queue, where the hero joins at the back once it is approved. */
function infraQueue(
  now: number,
  hero: { number: number; title: string; enqueuedAt: number } | null,
): MergeQueueView {
  const repo = INFRA;
  const entry = (
    position: number,
    state: "Queued" | "AwaitingChecks" | "Mergeable",
    prNumber: number,
    prTitle: string,
    author: string,
    enqueuedAgo: number,
    estimatedSecs: number,
  ) => ({
    position,
    state,
    prNumber,
    prTitle,
    prUrl: prUrl(repo, prNumber),
    author,
    authorAvatarUrl: avatar(author),
    isMine: author === ME,
    enqueuedAt: iso(now - enqueuedAgo),
    estimatedSecs,
  });
  return {
    repo,
    githubConnected: true,
    queue: {
      repo,
      branch: "main",
      url: `https://github.com/${repo}/queue/main`,
      nextEstimatedSecs: 240,
      mergedLast30Days: 132,
      entries: [
        entry(
          1,
          "Mergeable",
          91,
          "Kafka: raise scan-events retention to 14 days",
          PEOPLE.tom,
          38 * MIN,
          240,
        ),
        entry(
          2,
          "AwaitingChecks",
          93,
          "Alert on webhook delivery lag over 60s",
          PEOPLE.aisha,
          29 * MIN,
          720,
        ),
        entry(
          3,
          "Queued",
          94,
          "Bump the Postgres minor on every replica",
          PEOPLE.ethan,
          22 * MIN,
          1_180,
        ),
        entry(4, "Queued", 96, "Rotate the Datadog API key", PEOPLE.daniel, 14 * MIN, 1_640),
        entry(
          5,
          "Queued",
          97,
          "Terraform: tag every bucket with its owner",
          PEOPLE.jonas,
          7 * MIN,
          2_090,
        ),
        ...(hero
          ? [
              entry(
                6,
                "Queued",
                hero.number,
                hero.title,
                ME,
                Math.max(0, now - hero.enqueuedAt),
                2_520,
              ),
            ]
          : []),
      ],
    },
  };
}

export function prTickets(ids: string[]): TicketRef[] {
  return ids.flatMap((id) => {
    const seed = ticketSeed(id);
    if (!seed) return [];
    return [
      {
        identifier: seed.id,
        title: seed.title,
        priority: seed.priority,
        project: seed.project?.project ?? "No Project",
        projectColor: seed.project?.projectColor ?? null,
        projectIcon: seed.project?.projectIcon ?? null,
        projectTargetDate: null,
        projectMilestone: null,
      },
    ];
  });
}
