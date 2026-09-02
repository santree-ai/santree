/** The GitHub half of the fixture world: the review inbox, each pull request's
 *  detail, the AI review's drafts and brief, and the own-PR work queue. */
import type {
  MergeQueueView,
  PrCheck,
  PrComment,
  PrDetail,
  PrFile,
  PrThread,
  ReviewBrief,
  ReviewDraft,
  ReviewInbox,
  ReviewPr,
  ReviewWorkItem,
  TicketRef,
} from "../../bindings";
import { avatar, BEAK, DAY, HOUR, INFRA, iso, ME, MIN, PEOPLE, QUACK, taskById } from "./world";

interface PrSeed {
  repo: string;
  number: number;
  title: string;
  author: string;
  headRef: string;
  createdAgo: number;
  waitingAgo: number;
  pushedAgo: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  aiDrafts: number;
  checks: ReviewPr["checks"];
  decision: ReviewPr["reviewDecision"];
  isDraft?: boolean;
  inQueue?: boolean;
  /** Which inbox section carries it: mine, asked of me, or asked of a team. */
  section: "mine" | "requested" | "team";
  body: string;
}

const PRS: PrSeed[] = [
  {
    repo: QUACK,
    number: 417,
    title: "Rate-limit crumb requests per duck",
    author: PEOPLE.raul,
    headRef: "raul/qk-160-rate-limit-crumb-requests-per-duck",
    createdAgo: 2 * DAY,
    waitingAgo: 26 * HOUR,
    pushedAgo: 6 * HOUR,
    additions: 212,
    deletions: 34,
    changedFiles: 6,
    comments: 3,
    aiDrafts: 2,
    checks: "Success",
    decision: "ReviewRequired",
    section: "requested",
    body: `## Why

A single duck can request crumbs 40×/s and starve the rest of the pond. QK-119 added a bucket per *pond*; this makes it per *duck*.

## What

- \`rateLimit.ts\`: a token bucket keyed by duck id, 10 crumbs/s sustained, bursts of 30.
- \`dispenser.ts\` consults it before metering.
- Docs and a load test (\`pnpm bench:crumbs\`).

## Open question

Premium crumbs currently share the bucket with regular ones. I left it that way on purpose — shout if you disagree.

Closes QK-160.`,
  },
  {
    repo: QUACK,
    number: 420,
    title: "Pond thermostat: clamp readings to a physically possible range",
    author: PEOPLE.theo,
    headRef: "theo/thermostat-clamp",
    createdAgo: 9 * HOUR,
    waitingAgo: 4 * HOUR,
    pushedAgo: 90 * MIN,
    additions: 48,
    deletions: 9,
    changedFiles: 3,
    comments: 1,
    aiDrafts: 0,
    checks: "Failure",
    decision: "ReviewRequired",
    section: "requested",
    body: "Firmware 4.2 reports −273 °C. Clamp to [−40, 60] and flag the reading instead of trusting it.",
  },
  {
    repo: QUACK,
    number: 415,
    title: "Goose mode behind an opt-in flag",
    author: PEOPLE.priya,
    headRef: "priya/qk-136-goose-mode-opt-in",
    createdAgo: 3 * DAY,
    waitingAgo: 2 * DAY,
    pushedAgo: DAY,
    additions: 96,
    deletions: 31,
    changedFiles: 5,
    comments: 0,
    aiDrafts: 0,
    checks: "Pending",
    decision: "None",
    isDraft: true,
    section: "requested",
    body: "Flips the default and adds the toggle to pond settings. Still wiring the migration for existing ponds.",
  },
  {
    repo: INFRA,
    number: 57,
    title: "Rotate the pond thermostat certificate",
    author: PEOPLE.otto,
    headRef: "otto/inf-91-rotate-thermostat-cert",
    createdAgo: 5 * HOUR,
    waitingAgo: 3 * HOUR,
    pushedAgo: 3 * HOUR,
    additions: 22,
    deletions: 22,
    changedFiles: 2,
    comments: 0,
    aiDrafts: 0,
    checks: "Success",
    decision: "ReviewRequired",
    section: "requested",
    body: "The current certificate expires in 12 days. Same issuer, same SANs.",
  },
  {
    repo: QUACK,
    number: 419,
    title: "Emit ripple metrics from the pond worker",
    author: PEOPLE.mei,
    headRef: "mei/ripple-metrics",
    createdAgo: 20 * HOUR,
    waitingAgo: 18 * HOUR,
    pushedAgo: 18 * HOUR,
    additions: 131,
    deletions: 4,
    changedFiles: 4,
    comments: 2,
    aiDrafts: 0,
    checks: "Success",
    decision: "ReviewRequired",
    section: "team",
    body: "Ripple count, settle time and amplitude, as Prometheus histograms.",
  },
  {
    repo: QUACK,
    number: 421,
    title: "Bump webkit-pond to 3.1",
    author: PEOPLE.ada,
    headRef: "ada/bump-webkit-pond-3-1",
    createdAgo: 6 * HOUR,
    waitingAgo: 6 * HOUR,
    pushedAgo: 6 * HOUR,
    additions: 12,
    deletions: 12,
    changedFiles: 2,
    comments: 0,
    aiDrafts: 0,
    checks: "Success",
    decision: "ReviewRequired",
    section: "team",
    body: "Routine bump. Changelog is all Safari fixes, which we want for QK-142.",
  },
  {
    repo: QUACK,
    number: 418,
    title: "[QK-138] Migrate quack events to the pond_v2 schema",
    author: ME,
    headRef: "sam/qk-138-migrate-quack-events-to-the-pond-v2-schema",
    createdAgo: DAY,
    waitingAgo: 5 * HOUR,
    pushedAgo: 35 * MIN,
    additions: 412,
    deletions: 88,
    changedFiles: 4,
    comments: 2,
    aiDrafts: 1,
    checks: "Failure",
    decision: "ReviewRequired",
    section: "mine",
    body: `Moves \`quack_events\` onto \`pond_v2\` with a dual-write behind \`pond_v2_events\`.

- [x] Schema + migration
- [x] Dual-write
- [ ] Backfill job (this PR runs it in one transaction — see Ada's comment)
- [ ] Flip reads (follow-up)`,
  },
  {
    repo: QUACK,
    number: 412,
    title: "[QK-119] Rate-limit the bread dispenser API",
    author: ME,
    headRef: "sam/qk-119-rate-limit-the-bread-dispenser-api",
    createdAgo: 3 * DAY,
    waitingAgo: 2 * DAY,
    pushedAgo: 2 * HOUR,
    additions: 156,
    deletions: 12,
    changedFiles: 4,
    comments: 4,
    aiDrafts: 0,
    checks: "Success",
    decision: "Approved",
    inQueue: true,
    section: "mine",
    body: "A token bucket in front of the dispenser: 10 crumbs/s sustained, bursts of 30. Load test included.",
  },
];

const shaOf = (repo: string, n: number, salt: string) =>
  `${salt}${((n + repo.length) * 2654435761).toString(16)}`.padEnd(40, "0").slice(0, 40);

function toReviewPr(seed: PrSeed, now: number): ReviewPr {
  const headSha = shaOf(seed.repo, seed.number, "e01d3");
  return {
    id: `PR_${seed.repo.replace("/", "_")}_${seed.number}`,
    number: seed.number,
    title: seed.title,
    url: `https://github.com/${seed.repo}/pull/${seed.number}`,
    repo: seed.repo,
    project: seed.repo,
    headRef: seed.headRef,
    headRefId: `REF_${seed.number}h`,
    baseRef: "main",
    baseRefId: `REF_${seed.number}b`,
    headSha,
    author: seed.author,
    authorAvatarUrl: avatar(seed.author),
    state: "Open",
    isDraft: seed.isDraft ?? false,
    reviewDecision: seed.decision,
    checks: seed.checks,
    isInMergeQueue: seed.inQueue ?? false,
    additions: seed.additions,
    deletions: seed.deletions,
    changedFiles: seed.changedFiles,
    commentCount: seed.comments,
    aiDraftCount: seed.aiDrafts,
    reviewers:
      seed.section === "team"
        ? [{ kind: "Team", name: "pond-core", avatarUrl: avatar("Pond Core") }]
        : seed.section === "requested"
          ? [{ kind: "User", name: ME, avatarUrl: avatar(ME) }]
          : [{ kind: "User", name: PEOPLE.ada, avatarUrl: avatar(PEOPLE.ada) }],
    updatedAt: iso(now - seed.pushedAgo),
    createdAt: iso(now - seed.createdAgo),
    waitingSince: iso(now - seed.waitingAgo),
    headCommittedAt: iso(now - seed.pushedAgo),
    viewerReview: null,
  };
}

export function reviewInbox(now: number): ReviewInbox {
  const prs = PRS.map((seed) => ({ seed, pr: toReviewPr(seed, now) }));
  return {
    mine: prs.filter((p) => p.seed.section === "mine").map((p) => p.pr),
    requested: prs.filter((p) => p.seed.section === "requested").map((p) => p.pr),
    teams: [
      {
        org: "mallard-labs",
        slug: "pond-core",
        name: "Pond Core",
        prs: prs.filter((p) => p.seed.section === "team").map((p) => p.pr),
      },
    ],
    projects: [
      { repo: QUACK, slug: QUACK },
      { repo: INFRA, slug: INFRA },
      { repo: BEAK, slug: BEAK },
    ],
    orgs: ["mallard-labs"],
    githubConnected: true,
  };
}

export const prSummary = (repo: string, number: number, now: number): ReviewPr | null => {
  const seed = PRS.find((p) => p.repo === repo && p.number === number);
  return seed ? toReviewPr(seed, now) : null;
};

export const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;

// ── Detail ───────────────────────────────────────────────────────────────────

const comment = (
  author: string,
  body: string,
  createdAt: string,
  kind: PrComment["kind"] = "Issue",
  path: string | null = null,
): PrComment => ({
  author,
  authorAvatarUrl: avatar(author),
  body,
  createdAt,
  kind,
  path,
  isPending: false,
  isBot: false,
});

const file = (
  path: string,
  additions: number,
  deletions: number,
  patch: string | null,
  status = "modified",
): PrFile => ({
  path,
  previousPath: null,
  status,
  additions,
  deletions,
  patch,
  sha: shaOf(path, path.length, "f11e5"),
});

const RATE_LIMIT_PATCH = `@@ -0,0 +1,52 @@
+import type { DuckId } from "../flock/roster";
+
+/** A token bucket per duck: \`rate\` crumbs a second, up to \`burst\` at once. */
+export interface BucketOptions {
+  rate: number;
+  burst: number;
+}
+
+interface Bucket {
+  tokens: number;
+  refilledAt: number;
+}
+
+export class CrumbLimiter {
+  private readonly buckets = new Map<DuckId, Bucket>();
+
+  constructor(private readonly opts: BucketOptions = { rate: 10, burst: 30 }) {}
+
+  /** Whether \`duck\` may have a crumb right now, taking one if so. */
+  take(duck: DuckId, now = Date.now()): boolean {
+    const bucket = this.buckets.get(duck) ?? { tokens: this.opts.burst, refilledAt: now };
+    const elapsed = (now - bucket.refilledAt) / 1000;
+    // The window is recomputed on every call, so a request landing exactly on
+    // a second boundary is credited the whole second again.
+    bucket.tokens = Math.min(this.opts.burst, bucket.tokens + elapsed * this.opts.rate);
+    bucket.refilledAt = now;
+    if (bucket.tokens < 1) {
+      this.buckets.set(duck, bucket);
+      return false;
+    }
+    bucket.tokens -= 1;
+    this.buckets.set(duck, bucket);
+    return true;
+  }
+
+  /** Forget ducks that have not asked in a while, so the map stays bounded. */
+  sweep(olderThanMs: number, now = Date.now()): void {
+    for (const [duck, bucket] of this.buckets) {
+      if (now - bucket.refilledAt > olderThanMs) this.buckets.delete(duck);
+    }
+  }
+}
`;

const DISPENSER_PATCH = `@@ -1,12 +1,14 @@
 import { meter } from "./meter";
+import { CrumbLimiter } from "./rateLimit";
 import type { CrumbRequest, CrumbResponse } from "./types";
 
-const PER_POND_LIMIT = 400;
+const limiter = new CrumbLimiter({ rate: 10, burst: 30 });
 
 export async function dispense(req: CrumbRequest): Promise<CrumbResponse> {
-  if (await pondRequestsThisSecond(req.pond) > PER_POND_LIMIT) {
-    return { status: 429, retryAfterMs: 1000 };
+  if (!limiter.take(req.duck)) {
+    return { status: 429, retryAfterMs: 100 };
   }
   const budget = await meter(req.pond, req.duck);
   if (budget.remaining <= 0) return { status: 402, reason: "out of crumbs" };
@@ -108,7 +110,7 @@ export async function dispense(req: CrumbRequest): Promise<CrumbResponse> {
 
 function crumbKind(req: CrumbRequest) {
-  return req.premium ? "sourdough" : "white";
+  return req.premium && new Date(req.at).getHours() < 11 ? "sourdough" : "white";
 }
`;

const RATE_LIMIT_TEST_PATCH = `@@ -0,0 +1,31 @@
+import { describe, expect, it } from "vitest";
+
+import { CrumbLimiter } from "./rateLimit";
+
+describe("CrumbLimiter", () => {
+  it("lets a duck burst, then throttles", () => {
+    const limiter = new CrumbLimiter({ rate: 10, burst: 3 });
+    expect(limiter.take("gerald", 0)).toBe(true);
+    expect(limiter.take("gerald", 0)).toBe(true);
+    expect(limiter.take("gerald", 0)).toBe(true);
+    expect(limiter.take("gerald", 0)).toBe(false);
+  });
+
+  it("refills over time", () => {
+    const limiter = new CrumbLimiter({ rate: 10, burst: 1 });
+    expect(limiter.take("gerald", 0)).toBe(true);
+    expect(limiter.take("gerald", 50)).toBe(false);
+    expect(limiter.take("gerald", 100)).toBe(true);
+  });
+
+  it("keeps ducks apart", () => {
+    const limiter = new CrumbLimiter({ rate: 10, burst: 1 });
+    expect(limiter.take("gerald", 0)).toBe(true);
+    expect(limiter.take("mabel", 0)).toBe(true);
+  });
+});
`;

const DOCS_PATCH = `@@ -22,6 +22,10 @@ Every crumb request is metered against the pond's budget.
 
 ## Rate limits
 
-Requests are limited per pond: 400 a second across the flock.
+Requests are limited **per duck**: 10 a second sustained, with bursts of up to
+30. A throttled request gets \`429\` with \`Retry-After\` in milliseconds.
+
+Premium crumbs share the same bucket as regular ones.
`;

const MIGRATION_PATCH = `@@ -0,0 +1,18 @@
+-- pond_v2: quack events keyed by pond, partitioned by month.
+CREATE SCHEMA IF NOT EXISTS pond_v2;
+
+CREATE TABLE pond_v2.quack_events (
+  id          bigserial PRIMARY KEY,
+  pond_id     bigint      NOT NULL REFERENCES ponds(id),
+  duck_id     bigint      NOT NULL,
+  kind        text        NOT NULL,
+  payload     jsonb       NOT NULL DEFAULT '{}',
+  quacked_at  timestamptz NOT NULL
+) PARTITION BY RANGE (quacked_at);
+
+-- Backfill the last 90 days in one go.
+INSERT INTO pond_v2.quack_events (pond_id, duck_id, kind, payload, quacked_at)
+SELECT pond_id, duck_id, kind, payload, quacked_at
+  FROM public.quack_events
+ WHERE quacked_at > now() - interval '90 days';
`;

const check = (
  name: string,
  status: PrCheck["status"],
  now: number,
  extra: Partial<PrCheck> = {},
): PrCheck => ({
  name,
  status,
  description:
    status === "Success"
      ? "Successful in 3m 12s"
      : status === "Failure"
        ? "Failing after 4m 05s"
        : null,
  url: `https://github.com/${QUACK}/actions/runs/91${name.length}`,
  steps: [],
  annotations: [],
  jobId: 9100 + name.length,
  runId: 71000 + name.length,
  startedAt: iso(now - 20 * MIN),
  completedAt: status === "Pending" ? null : iso(now - 16 * MIN),
  ...extra,
});

const thread = (
  id: string,
  path: string,
  line: number,
  comments: PrComment[],
  isResolved = false,
): PrThread => ({
  id,
  replyToId: `${id}-c0`,
  path,
  line,
  startLine: null,
  onRight: true,
  isResolved,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  comments,
});

export function prDetail(repo: string, number: number, now: number): PrDetail {
  const seed = PRS.find((p) => p.repo === repo && p.number === number);
  const summary = seed ? toReviewPr(seed, now) : null;
  const headSha = summary?.headSha ?? shaOf(repo, number, "e01d3");
  const baseSha = shaOf(repo, number, "b45e0");
  const base: PrDetail = {
    body: seed?.body ?? "",
    attachments: [],
    labels: [],
    comments: [],
    threads: [],
    files: [],
    filesTruncated: false,
    commits: [],
    commitsTruncated: false,
    checks: [
      check("build", "Success", now),
      check("test", "Success", now),
      check("lint", "Success", now),
    ],
    baseSha,
    headSha,
    pendingReviewId: null,
  };
  const author = seed?.author ?? PEOPLE.ada;
  const commit = (n: number, headline: string, agoMs: number) => ({
    oid: shaOf(repo, number * 10 + n, "c0de"),
    abbreviatedOid: shaOf(repo, number * 10 + n, "c0de").slice(0, 7),
    messageHeadline: headline,
    messageBody: "",
    author,
    authorAvatarUrl: avatar(author),
    committedDate: iso(now - agoMs),
    url: `https://github.com/${repo}/commit/${shaOf(repo, number * 10 + n, "c0de")}`,
  });

  if (repo === QUACK && number === 417) {
    return {
      ...base,
      labels: [
        { name: "bread-api", color: "d97706", description: "The crumb dispenser" },
        { name: "needs-review", color: "5e6ad2", description: null },
      ],
      comments: [
        comment(
          PEOPLE.raul,
          "Load test numbers, 200 ducks × 60s: p50 4ms, p99 11ms, zero 5xx. The old per-pond limiter tripped 3.2% of legitimate requests under the same load.",
          iso(now - 25 * HOUR),
        ),
        comment(
          PEOPLE.ada,
          "Nice. One thing I'd like a second opinion on: should sourdough (premium) requests get their own bucket? A premium duck paying for crumbs and getting throttled by its own free requests feels off.",
          iso(now - 22 * HOUR),
        ),
        comment(
          PEOPLE.raul,
          "Fair. I'd rather ship this per-duck first and split the buckets in a follow-up once we see real traffic — but happy to do it here if @samwaddle prefers.",
          iso(now - 21 * HOUR),
        ),
      ],
      threads: [
        thread("PRRT_417_1", "src/bread/rateLimit.ts", 24, [
          comment(
            PEOPLE.ada,
            "This refills on every call — is a request that lands exactly on the boundary credited twice?",
            iso(now - 23 * HOUR),
            "ReviewThread",
            "src/bread/rateLimit.ts",
          ),
          comment(
            PEOPLE.raul,
            'Only if `now` is identical in two calls, which the tests cover with `take("gerald", 0)` twice. Adding a comment.',
            iso(now - 22 * HOUR),
            "ReviewThread",
            "src/bread/rateLimit.ts",
          ),
        ]),
        thread(
          "PRRT_417_2",
          "src/bread/dispenser.ts",
          8,
          [
            comment(
              PEOPLE.mei,
              "`retryAfterMs: 100` — do the clients honour this or just hammer? Worth checking `beak` before we ship.",
              iso(now - 20 * HOUR),
              "ReviewThread",
              "src/bread/dispenser.ts",
            ),
          ],
          true,
        ),
      ],
      files: [
        file("src/bread/rateLimit.ts", 52, 0, RATE_LIMIT_PATCH, "added"),
        file("src/bread/dispenser.ts", 8, 6, DISPENSER_PATCH),
        file("src/bread/rateLimit.test.ts", 31, 0, RATE_LIMIT_TEST_PATCH, "added"),
        file("docs/bread-api.md", 5, 1, DOCS_PATCH),
        file("src/bread/meter.ts", 4, 2, null),
        file("scripts/bench-crumbs.ts", 112, 25, null),
      ],
      commits: [
        commit(1, "Add a per-duck crumb limiter", 2 * DAY),
        commit(2, "Consult the limiter before metering", 30 * HOUR),
        commit(3, "Docs + load test", 6 * HOUR),
      ],
      checks: [
        check("build", "Success", now),
        check("test", "Success", now),
        check("lint", "Success", now),
        check("e2e", "Skipped", now, { description: "Skipped: no UI changes" }),
      ],
    };
  }

  if (repo === QUACK && number === 418) {
    return {
      ...base,
      labels: [{ name: "migration", color: "0ea5a4", description: null }],
      comments: [
        comment(
          PEOPLE.ada,
          "Should the backfill run in batches? 40k ponds in one transaction worries me — the last migration of that size held the events table lock for six minutes.",
          iso(now - 5 * HOUR),
        ),
        comment(
          ME,
          "Agreed, batching it. CI is also red on the backfill test — looking now.",
          iso(now - 40 * MIN),
        ),
      ],
      threads: [
        thread("PRRT_418_1", "migrations/0042_pond_v2.sql", 13, [
          comment(
            PEOPLE.ada,
            "This is the one — a single INSERT … SELECT over 90 days. Batches of 500 by pond id, resumable?",
            iso(now - 5 * HOUR),
            "ReviewThread",
            "migrations/0042_pond_v2.sql",
          ),
        ]),
      ],
      files: [
        file("migrations/0042_pond_v2.sql", 18, 0, MIGRATION_PATCH, "added"),
        file("src/pond/events.ts", 210, 64, null),
        file("src/pond/events.test.ts", 96, 24, null),
        file("src/pond/backfill.ts", 88, 0, null, "added"),
      ],
      commits: [
        commit(1, "pond_v2 schema + migration", DAY),
        commit(2, "Dual-write quack events", 20 * HOUR),
        commit(3, "Backfill job", 3 * HOUR),
        commit(4, "Fix the partition key on the backfill", 35 * MIN),
      ],
      checks: [
        check("build", "Success", now),
        check("test", "Failure", now, {
          description: "Failing after 4m 05s · 1 failed, 212 passed",
          steps: [
            { number: 1, name: "Set up job", status: "Success" },
            { number: 2, name: "Install", status: "Success" },
            { number: 3, name: "pnpm vitest run", status: "Failure" },
            { number: 4, name: "Upload coverage", status: "Skipped" },
          ],
          annotations: [
            {
              level: "failure",
              message:
                "pond_v2 migration › backfills legacy ponds: expected 3 rows in pond_v2.quack_events, got 2",
              path: "src/pond/events.test.ts",
              startLine: 142,
              title: "AssertionError",
              rawDetails: null,
            },
          ],
        }),
        check("lint", "Success", now),
        check("migrate --dry-run", "Pending", now, { description: "Queued" }),
      ],
    };
  }

  if (repo === QUACK && number === 412) {
    return {
      ...base,
      labels: [{ name: "bread-api", color: "d97706", description: "The crumb dispenser" }],
      comments: [
        comment(
          PEOPLE.ada,
          "LGTM. Approving — nice load test.",
          iso(now - 2 * DAY + HOUR),
          "Review",
        ),
        comment(PEOPLE.raul, "Following up with the per-duck version in #417.", iso(now - DAY)),
      ],
      files: [
        file("src/bread/rateLimit.ts", 92, 0, RATE_LIMIT_PATCH, "added"),
        file("src/bread/rateLimit.test.ts", 51, 0, RATE_LIMIT_TEST_PATCH, "added"),
        file("src/bread/dispenser.ts", 9, 12, DISPENSER_PATCH),
        file("docs/bread-api.md", 4, 0, DOCS_PATCH),
      ],
      commits: [
        commit(1, "Token bucket in front of the dispenser", 3 * DAY),
        commit(2, "Load test", 2 * DAY),
        commit(3, "Address review: bound the bucket map", 2 * HOUR),
      ],
    };
  }

  if (repo === QUACK && number === 420) {
    return {
      ...base,
      comments: [
        comment(
          PEOPLE.otto,
          "The firmware team says 4.2.1 fixes the sensor, but I'd still take the clamp.",
          iso(now - 3 * HOUR),
        ),
      ],
      files: [
        file("src/thermostat/read.ts", 31, 6, null),
        file("src/thermostat/read.test.ts", 15, 3, null),
        file("docs/thermostat.md", 2, 0, null),
      ],
      commits: [
        commit(1, "Clamp thermostat readings", 9 * HOUR),
        commit(2, "Flag clamped readings", 90 * MIN),
      ],
      checks: [
        check("build", "Success", now),
        check("test", "Failure", now, {
          description: "Failing after 1m 40s · 1 failed, 88 passed",
          annotations: [
            {
              level: "failure",
              message: "read › flags a clamped reading: expected flagged to be true",
              path: "src/thermostat/read.test.ts",
              startLine: 27,
              title: "AssertionError",
              rawDetails: null,
            },
          ],
        }),
        check("lint", "Success", now),
      ],
    };
  }

  return {
    ...base,
    files: [file("src/index.ts", seed?.additions ?? 1, seed?.deletions ?? 0, null)],
    commits: [commit(1, seed?.title ?? "Update", seed?.pushedAgo ?? HOUR)],
    checks: base.checks.map((c) => ({
      ...c,
      status: seed?.checks === "Pending" ? "Pending" : c.status,
    })),
  };
}

// ── The AI's work ────────────────────────────────────────────────────────────

export function reviewDrafts(repo: string, number: number, now: number): ReviewDraft[] {
  if (repo !== QUACK || number !== 417) return [];
  const headSha = prSummary(repo, number, now)?.headSha ?? "";
  return [
    {
      agentKind: "Codex",
      id: "draft-417-1",
      prRepo: repo,
      prNumber: number,
      headSha,
      path: "src/bread/rateLimit.ts",
      line: 24,
      startLine: 22,
      onRight: true,
      body: "The bucket refills with `elapsed * rate` and then clamps to `burst`, but `refilledAt` is written back even when nothing was taken — a duck polling faster than the refill rate advances the clock without ever earning a token. Track the fractional remainder, or only move `refilledAt` when tokens were credited.",
      suggestion: null,
      createdAtMs: now - 12 * MIN,
      updatedAtMs: now - 12 * MIN,
    },
    {
      agentKind: "Codex",
      id: "draft-417-2",
      prRepo: repo,
      prNumber: number,
      headSha,
      path: "src/bread/dispenser.ts",
      line: 112,
      startLine: null,
      onRight: true,
      body: "This change is unrelated to rate limiting: sourdough is now only served before 11am. If that is intentional it deserves its own PR and a line in the docs; if not, it slipped in from the bench branch.",
      suggestion: '  return req.premium ? "sourdough" : "white";',
      createdAtMs: now - 9 * MIN,
      updatedAtMs: now - 9 * MIN,
    },
  ];
}

export function reviewBrief(repo: string, number: number, now: number): ReviewBrief | null {
  if (repo !== QUACK || number !== 417) return null;
  return {
    agentKind: "Codex",
    summary:
      "Replaces the per-pond request cap with a per-duck token bucket in front of the crumb dispenser. The bucket is a small, self-contained class; the dispenser consults it before metering and answers 429 with a 100ms retry. Tests cover bursts, refill and duck isolation. One unrelated behaviour change rode along in the dispenser.",
    readingOrder: [
      {
        path: "src/bread/rateLimit.ts",
        role: "coreLogic",
        why: "The token bucket itself — 50 lines, read it whole.",
      },
      {
        path: "src/bread/dispenser.ts",
        role: "entryPoint",
        why: "Where the bucket is consulted, and the unrelated crumbKind change.",
      },
      {
        path: "src/bread/rateLimit.test.ts",
        role: "test",
        why: "Burst, refill and isolation cases; no boundary case.",
      },
      { path: "docs/bread-api.md", role: "trivial", why: "States the new limits." },
    ],
    watchOuts: [
      {
        path: "src/bread/rateLimit.ts",
        line: 24,
        kind: "correctness",
        note: "refilledAt advances even when no token was credited — a fast poller starves itself.",
      },
      {
        path: "src/bread/dispenser.ts",
        line: 112,
        kind: "question",
        note: "Sourdough is now time-of-day gated. Unrelated to this PR.",
      },
      {
        path: "src/bread/rateLimit.ts",
        line: 37,
        kind: "performance",
        note: "Nothing calls sweep(); the map grows with every duck that ever asked.",
      },
    ],
    questions: [
      "Should premium crumbs share a bucket with regular ones? Ada asked the same in the conversation.",
    ],
    truncated: false,
    headSha: prSummary(repo, number, now)?.headSha ?? "",
    generatedAtMs: now - 14 * MIN,
  };
}

export function reviewWorkItems(repo: string, number: number, now: number): ReviewWorkItem[] {
  if (repo !== QUACK || number !== 418) return [];
  const item = (
    id: string,
    body: string,
    source: ReviewWorkItem["source"],
    done: boolean,
    path: string | null = null,
    line: number | null = null,
    sourceId: string | null = null,
  ): ReviewWorkItem => ({
    id,
    prRepo: repo,
    prNumber: number,
    body,
    done,
    source,
    sourceId,
    path,
    line,
    startLine: null,
    onRight: path ? true : null,
    createdAtMs: now - 30 * MIN,
    updatedAtMs: now - 5 * MIN,
  });
  return [
    item(
      "wi-418-1",
      "Failing check test: pond_v2 migration › backfills legacy ponds — expected 3 rows in pond_v2.quack_events, got 2",
      "check",
      false,
      null,
      null,
      "test",
    ),
    item(
      "wi-418-2",
      "Ada: run the backfill in batches of 500 by pond id, resumable, instead of one INSERT … SELECT over 90 days",
      "githubThread",
      false,
      "migrations/0042_pond_v2.sql",
      13,
      "PRRT_418_1-c0",
    ),
    item(
      "wi-418-3",
      "Guard against ponds with no ducks: the join drops them from the backfill",
      "aiDraft",
      true,
      "src/pond/backfill.ts",
      31,
    ),
    item("wi-418-4", "Mention the dual-write flag in docs/pond-2.0.md", "manual", false),
  ];
}

export function mergeQueue(repo: string, now: number): MergeQueueView {
  if (repo !== QUACK) return { repo, githubConnected: true, queue: null };
  return {
    repo,
    githubConnected: true,
    queue: {
      repo,
      branch: "main",
      url: `https://github.com/${repo}/queue/main`,
      nextEstimatedSecs: 540,
      mergedLast30Days: 87,
      entries: [
        {
          position: 1,
          state: "AwaitingChecks",
          prNumber: 411,
          prTitle: "Retry pond snapshots on 429",
          prUrl: prUrl(repo, 411),
          author: PEOPLE.mei,
          authorAvatarUrl: avatar(PEOPLE.mei),
          isMine: false,
          enqueuedAt: iso(now - 14 * MIN),
          estimatedSecs: 540,
        },
        {
          position: 2,
          state: "Queued",
          prNumber: 412,
          prTitle: "[QK-119] Rate-limit the bread dispenser API",
          prUrl: prUrl(repo, 412),
          author: ME,
          authorAvatarUrl: avatar(ME),
          isMine: true,
          enqueuedAt: iso(now - 6 * MIN),
          estimatedSecs: 1080,
        },
      ],
    },
  };
}

export function prTickets(ids: string[], now: number): TicketRef[] {
  return ids.flatMap((id) => {
    const task = taskById(id, now);
    return task
      ? [
          {
            identifier: task.id,
            title: task.title,
            priority: task.priority,
            project: task.project,
            projectColor: task.projectColor,
            projectIcon: task.projectIcon,
            projectTargetDate: task.projectTargetDate,
            projectMilestone: task.projectMilestone,
          },
        ]
      : [];
  });
}
