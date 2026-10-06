/**
 * The hero ticket, PLAT-421 (webhook retries deliver duplicate events): the one
 * the demo follows from launch to merge queue. Its agent finishes fast and
 * leaves the fix uncommitted; once its PR is opened, CI and two coworkers
 * arrive on their own; the AI review and the work queue take it to green.
 *
 * Three versions of its files: `main` (before), `v1` (the agent's first pass,
 * what the PR opens with) and `v2` (after the queue run).
 */
import type {
  AgentKind,
  PrCheck,
  PrComment,
  PrDetail,
  PrThread,
  ReviewBrief,
  ReviewDraft,
} from "../../../bindings";
import type { SourceFile } from "./code";
import { avatar, INFRA, iso, LOGIN, ME, PEOPLE, SEC } from "./company";
import { diffOf } from "./diff";

export const HERO = "PLAT-421";
/** Where the demo launches its four tickets, the hero included: its own
 *  project, first in the sidebar, so the new work never mixes with the old. */
export const HERO_REPO = INFRA;

// ── main ─────────────────────────────────────────────────────────────────────

const WORKER_MAIN = `import { db } from "../db";
import { deliver } from "./deliver";

const BATCH = 100;
const POLL_MS = 1_000;

/**
 * Re-send every delivery that hasn't succeeded yet. Runs on several workers at
 * once; a delivery counts as done once \`delivered_at\` is written.
 */
export async function runRetryWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const due = await db.webhookDeliveries.findMany({
      where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: "asc" },
      take: BATCH,
    });
    await Promise.all(due.map((delivery) => deliver(delivery)));
    await sleep(POLL_MS);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
`;

const DELIVER_MAIN = `import { db, type DeliveryRow } from "../db";
import { sign } from "./signing";

const TIMEOUT_MS = 45_000;

/** POST one event to one endpoint and record the outcome. */
export async function deliver(delivery: DeliveryRow): Promise<void> {
  const { event, endpoint } = delivery;
  const body = JSON.stringify(event.payload);
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Parcelwise-Signature": sign(body, endpoint.secret),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(\`endpoint answered \${res.status}\`);
    await db.webhookDeliveries.update(delivery.id, { deliveredAt: new Date() });
  } catch (err) {
    await db.webhookDeliveries.update(delivery.id, {
      attempts: delivery.attempts + 1,
      nextAttemptAt: backoff(delivery.attempts + 1),
      lastError: String(err),
    });
  }
}

/** 10s, 20s, 40s … capped at an hour. */
function backoff(attempt: number): Date {
  return new Date(Date.now() + Math.min(3_600_000, 10_000 * 2 ** (attempt - 1)));
}
`;

const DOCS_MAIN = `# Webhooks

Parcelwise sends a \`POST\` to your endpoint for every shipment event you
subscribe to. Respond with any \`2xx\` within 45 seconds.

## Retries

A delivery that fails or times out is retried with exponential backoff (10s,
20s, 40s, … up to an hour between attempts) for 72 hours.
`;

// ── v1: the agent's first pass ───────────────────────────────────────────────

const WORKER_V1 = `import { db } from "../db";
import { deliver } from "./deliver";

const BATCH = 100;
const POLL_MS = 1_000;
/** How long a worker owns a delivery it has claimed. */
const LEASE_MS = 30_000;

/**
 * Re-send every delivery that hasn't succeeded yet. Runs on several workers at
 * once, so each claims a delivery with a lease before sending it: another
 * worker skips it until the lease runs out.
 */
export async function runRetryWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const claimed = await claimDue(BATCH);
    await Promise.all(claimed.map((delivery) => deliver(delivery)));
    await sleep(POLL_MS);
  }
}

async function claimDue(limit: number) {
  const now = new Date();
  const due = await db.webhookDeliveries.findMany({
    where: {
      deliveredAt: null,
      nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  await db.webhookDeliveries.updateMany(
    due.map((d) => d.id),
    { leaseUntil },
  );
  return due.map((d) => ({ ...d, leaseUntil }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
`;

const DELIVER_V1 = DELIVER_MAIN.replace(
  `        "Parcelwise-Signature": sign(body, endpoint.secret),`,
  `        "Parcelwise-Signature": sign(body, endpoint.secret),
        // Lets shippers drop the retries we do send (PLAT-421).
        "Idempotency-Key": event.id,`,
).replace(
  "    await db.webhookDeliveries.update(delivery.id, { deliveredAt: new Date() });",
  "    await db.webhookDeliveries.update(delivery.id, { deliveredAt: new Date(), leaseUntil: null });",
);

const MIGRATION_V1 = `-- A worker claims a delivery before sending it; others skip it until the
-- lease runs out (PLAT-421).
ALTER TABLE webhook_deliveries ADD COLUMN lease_until timestamptz;
`;

const TEST_V1 = `import { afterEach, describe, expect, it, vi } from "vitest";

import { aDelivery, fakeEndpoint } from "../test/factories";
import { runWorkersFor } from "../test/workers";

describe("retry worker", () => {
  afterEach(() => vi.useRealTimers());

  it("delivers once to an endpoint slower than the poll interval", async () => {
    const endpoint = fakeEndpoint({ respondAfterMs: 12_000 });
    await aDelivery({ endpoint, nextAttemptAt: new Date() });
    await runWorkersFor({ workers: 3, ms: 20_000 });
    expect(endpoint.received).toHaveLength(1);
  });

  it("delivers once to an endpoint slower than the lease", async () => {
    const endpoint = fakeEndpoint({ respondAfterMs: 40_000 });
    await aDelivery({ endpoint, nextAttemptAt: new Date() });
    await runWorkersFor({ workers: 3, ms: 60_000 });
    expect(endpoint.received).toHaveLength(1);
  });

  it("sends an Idempotency-Key", async () => {
    const endpoint = fakeEndpoint();
    const delivery = await aDelivery({ endpoint, nextAttemptAt: new Date() });
    await runWorkersFor({ workers: 1, ms: 2_000 });
    expect(endpoint.received[0].headers["idempotency-key"]).toBe(delivery.event.id);
  });
});
`;

const DOCS_V1 = `${DOCS_MAIN}
## Idempotency

Every delivery carries an \`Idempotency-Key\` header. A retry of the same event
carries the same key, so you can safely ignore a key you have already processed.
`;

// ── v2: after the work queue ─────────────────────────────────────────────────

const WORKER_V2 = `import { db } from "../db";
import { metrics } from "../metrics";
import { deliver } from "./deliver";

const BATCH = 100;
const POLL_MS = 1_000;
/** How long a claim lasts before it is renewed; renewed every half lease. */
const LEASE_MS = 30_000;

/**
 * Re-send every delivery that hasn't succeeded yet. Runs on several workers at
 * once, so each claims a delivery with a lease before sending it and renews
 * the lease while the request is in flight: a slow endpoint never outlives it.
 */
export async function runRetryWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const claimed = await claimDue(BATCH);
    await Promise.all(claimed.map((delivery) => withLease(delivery.id, () => deliver(delivery))));
    await sleep(POLL_MS);
  }
}

/**
 * Claim due deliveries in one statement: \`SKIP LOCKED\` keeps two workers from
 * ever selecting the same row, which a select-then-update can't promise.
 */
async function claimDue(limit: number) {
  const rows = await db.query<DeliveryRow>(
    \`UPDATE webhook_deliveries SET lease_until = now() + $2 * interval '1 millisecond'
      WHERE id IN (
        SELECT id FROM webhook_deliveries
         WHERE delivered_at IS NULL AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY next_attempt_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING *\`,
    [limit, LEASE_MS],
  );
  const expired = rows.filter((r) => r.leaseUntilBefore !== null).length;
  if (expired > 0) metrics.increment("webhooks.lease_expired", expired);
  return rows;
}

/** Keep renewing the claim until \`send\` settles. */
async function withLease(id: string, send: () => Promise<void>): Promise<void> {
  const renew = setInterval(() => {
    void db.webhookDeliveries.update(id, { leaseUntil: new Date(Date.now() + LEASE_MS) });
  }, LEASE_MS / 2);
  try {
    await send();
  } finally {
    clearInterval(renew);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
`.replace('import { db } from "../db";', 'import { db, type DeliveryRow } from "../db";');

const DELIVER_V2 = DELIVER_V1.replace(
  `        // Lets shippers drop the retries we do send (PLAT-421).
        "Idempotency-Key": event.id,`,
  `        // Lets shippers drop the retries we do send. Per endpoint: a shipper
        // with several endpoints may dedupe across them (PLAT-421).
        "Idempotency-Key": \`\${event.id}:\${endpoint.id}\`,`,
).replace(
  "      lastError: String(err),\n    });",
  "      lastError: String(err),\n      // Free it now, or the retry waits out the lease on top of the backoff.\n      leaseUntil: null,\n    });",
);

const MIGRATION_V2 = `${MIGRATION_V1}
-- The claim query filters on both; without this it scans every delivery.
CREATE INDEX CONCURRENTLY webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at, lease_until)
  WHERE delivered_at IS NULL;
`;

const TEST_V2 = TEST_V1.replace(
  "toBe(delivery.event.id);",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text for the demo file, not a template.
  "toBe(`${delivery.event.id}:${endpoint.id}`);",
);

const DOCS_V2 = DOCS_V1.replace(
  "Every delivery carries an `Idempotency-Key` header. A retry of the same event\ncarries the same key,",
  "Every delivery carries an `Idempotency-Key` header, unique per event and\nendpoint. A retry of the same event to the same endpoint carries the same key,",
);

const DB_TYPES_OLD = `export interface DeliveryRow {
  id: string;
  event: { id: string; type: string; payload: unknown };
  endpoint: { id: string; url: string; secret: string };
  attempts: number;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  lastError: string | null;
}
`;

const DB_TYPES_V2 = DB_TYPES_OLD.replace(
  "  lastError: string | null;\n}",
  "  lastError: string | null;\n  leaseUntil: Date | null;\n  /** The lease this claim replaced, if one had run out. */\n  leaseUntilBefore: Date | null;\n}",
);

const W = "src/webhooks/retryWorker.ts";
const D = "src/webhooks/deliver.ts";
const M = "db/migrations/0088_webhook_delivery_lease.sql";
const T = "src/webhooks/retryWorker.test.ts";
const DOCS = "docs/api/webhooks.md";
const DB = "src/db/types/deliveries.ts";

/** The agent's first pass, against main: what lands uncommitted, then in the PR. */
export const HERO_V1: SourceFile[] = [
  { path: W, oldText: WORKER_MAIN, newText: WORKER_V1 },
  { path: D, oldText: DELIVER_MAIN, newText: DELIVER_V1 },
  { path: M, oldText: "", newText: MIGRATION_V1 },
  { path: T, oldText: "", newText: TEST_V1 },
  { path: DOCS, oldText: DOCS_MAIN, newText: DOCS_V1 },
];

/** After the queue run, against main. */
export const HERO_V2: SourceFile[] = [
  { path: W, oldText: WORKER_MAIN, newText: WORKER_V2 },
  { path: D, oldText: DELIVER_MAIN, newText: DELIVER_V2 },
  { path: M, oldText: "", newText: MIGRATION_V2 },
  { path: T, oldText: "", newText: TEST_V2 },
  { path: DOCS, oldText: DOCS_MAIN, newText: DOCS_V2 },
  { path: DB, oldText: DB_TYPES_OLD, newText: DB_TYPES_V2 },
];

/** v1 → v2 as working-tree changes on top of the committed v1. */
export function heroFixChanges() {
  return HERO_V2.flatMap((f) => {
    const before = HERO_V1.find((v) => v.path === f.path)?.newText ?? f.oldText;
    return before === f.newText ? [] : [{ path: f.path, oldText: before, newText: f.newText }];
  });
}

const lineIn = (text: string, needle: string, last = false) => {
  const lines = text.split("\n");
  const hits = lines.flatMap((l, n) => (l.includes(needle) ? [n] : []));
  const i = hits.length === 0 ? -1 : last ? hits[hits.length - 1] : hits[0];
  return i === -1 ? 1 : i + 1;
};

// ── The PR, as it comes alive ────────────────────────────────────────────────

export interface HeroPr {
  number: number;
  /** The demo speed when it opened: CI and comments run this much faster. */
  speed: number;
  openedAt: number;
  /** The queue run's fixes were pushed. */
  fixedAt: number | null;
}

/** Seconds after opening when each thing lands on the PR. */
/** Seconds after opening when each coworker comment lands. CI has its own
 *  timeline (`FIRST_RUN`). */
export const BEATS = { aisha: 9, maya: 20, daniel: 25 } as const;
/** Seconds after the fix push when Daniel approves (CI is green by then). */
export const FIX_BEATS = { approved: 33 } as const;

export const HERO_COMMENTS = {
  daniel: `The HTTP timeout is 45s and the lease is 30s, so an endpoint slower than 30s still gets a second delivery — that's the red test. Renew the lease while the request is in flight, or make it longer than the timeout.`,
  aisha: `@${LOGIN[ME]} shippers with several endpoints will see the same key on each, and a couple of them dedupe across endpoints — they'd drop real deliveries. Can we key it per event *and* endpoint?`,
  maya: "Could we count lease expirations? If they ever happen in prod I'd like an alert — it means an endpoint is slower than we think.",
};

const comment = (
  author: string,
  body: string,
  at: number,
  kind: PrComment["kind"] = "Issue",
  path: string | null = null,
  reviewState: PrComment["reviewState"] = null,
): PrComment => ({
  author,
  authorAvatarUrl: avatar(author),
  body,
  createdAt: iso(at),
  kind,
  reviewState: kind === "Review" ? (reviewState ?? "Commented") : null,
  path,
  isPending: false,
  isBot: false,
});

const thread = (
  id: string,
  path: string,
  line: number,
  c: PrComment,
  resolved: boolean,
): PrThread => ({
  id,
  replyToId: `${id}-c0`,
  path,
  line,
  startLine: null,
  onRight: true,
  isResolved: resolved,
  isOutdated: false,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  comments: [c],
});

type Outcome = "Success" | "Failure" | "Skipped" | "Neutral";

/** One job of a CI run: when it starts and ends (seconds after the push) and
 *  how it ends. Before `start` it reads as queued, until `end` as running. */
interface CiJob {
  name: string;
  start: number;
  end: number;
  outcome: Outcome;
  jobId: number;
  /** The description once finished, when not the default "Successful in …". */
  note?: string;
  failure?: Partial<PrCheck>;
}

const TYPECHECK_JOB = 41_117;
const UNIT_2_JOB = 41_202;

/** Which failing job a check log request is for. */
export const heroJobLog = (jobId: number): "typecheck" | "unit" | null =>
  jobId === TYPECHECK_JOB ? "typecheck" : jobId === UNIT_2_JOB ? "unit" : null;

const typecheckFail: Partial<PrCheck> = {
  steps: [
    { number: 1, name: "Set up job", status: "Success" },
    { number: 2, name: "pnpm install", status: "Success" },
    { number: 3, name: "pnpm typecheck", status: "Failure" },
  ],
  annotations: [
    {
      level: "failure",
      message: "Property 'leaseUntil' does not exist on type 'DeliveryRow'.",
      path: W,
      startLine: lineIn(WORKER_V1, "OR: [{ leaseUntil"),
      title: "TS2339",
      rawDetails: null,
    },
  ],
};

const unitFail: Partial<PrCheck> = {
  steps: [
    { number: 1, name: "Set up job", status: "Success" },
    { number: 2, name: "Start Postgres", status: "Success" },
    { number: 3, name: "pnpm vitest run --shard=2/3", status: "Failure" },
    { number: 4, name: "Upload coverage", status: "Skipped" },
  ],
  annotations: [
    {
      level: "failure",
      message:
        "retry worker › delivers once to an endpoint slower than the lease: expected [ …(2) ] to have a length of 1 but got 2",
      path: T,
      startLine: lineIn(TEST_V1, "slower than the lease") + 4,
      title: "AssertionError",
      rawDetails: null,
    },
  ],
};

/** CI on the PR as opened: two failures, a skip and a neutral among the passes. */
const FIRST_RUN: CiJob[] = [
  {
    name: "Preview deploy",
    start: 0,
    end: 1,
    outcome: "Skipped",
    jobId: 41_001,
    note: "Skipped: no frontend changes",
  },
  { name: "Danger", start: 1, end: 6, outcome: "Success", jobId: 41_011 },
  { name: "CI / install", start: 1, end: 5, outcome: "Success", jobId: 41_021 },
  { name: "CI / lint", start: 5, end: 9, outcome: "Success", jobId: 41_031 },
  { name: "CI / build", start: 5, end: 11, outcome: "Success", jobId: 41_041 },
  {
    name: "CI / typecheck",
    start: 5,
    end: 12,
    outcome: "Failure",
    jobId: TYPECHECK_JOB,
    note: "Failing after 1m 12s · 1 error",
    failure: typecheckFail,
  },
  { name: "CI / unit (1/3)", start: 6, end: 15, outcome: "Success", jobId: 41_201 },
  {
    name: "CI / unit (2/3)",
    start: 6,
    end: 17,
    outcome: "Failure",
    jobId: UNIT_2_JOB,
    note: "Failing after 2m 48s · 1 failed, 171 passed",
    failure: unitFail,
  },
  { name: "CI / unit (3/3)", start: 6, end: 16, outcome: "Success", jobId: 41_203 },
  {
    name: "codecov/patch",
    start: 17,
    end: 18,
    outcome: "Neutral",
    jobId: 41_301,
    note: "84.1% of diff hit (target 85.0%)",
  },
  { name: "CI / e2e (chromium)", start: 11, end: 27, outcome: "Success", jobId: 41_401 },
];

/** CI on the fix commit: the same matrix, all green. */
const FIX_RUN: CiJob[] = FIRST_RUN.map((job) => {
  const { failure: _, ...rest } = job;
  if (job.name === "Preview deploy") return job;
  if (job.name === "codecov/patch")
    return { ...rest, outcome: "Success", note: "91.6% of diff hit (target 85.0%)" };
  if (job.name === "CI / e2e (chromium)") return { ...rest, end: 22 };
  return { ...rest, outcome: "Success", note: undefined };
});

/** Wall-clock milliseconds per scripted second, at the PR's speed. */
const ms = (pr: HeroPr) => SEC / pr.speed;

/** How much longer than the tables above CI really takes: they read as one
 *  run's shape, this sets its pace (comment beats are tuned against it). */
const CI_STRETCH = 1.4;
const stretch = (run: CiJob[]) =>
  run.map((j) => ({ ...j, start: j.start * CI_STRETCH, end: j.end * CI_STRETCH }));
const FIRST = stretch(FIRST_RUN);
const FIX = stretch(FIX_RUN);

const runOf = (pr: HeroPr) => (pr.fixedAt === null ? FIRST : FIX);
const pushedAt = (pr: HeroPr) => pr.fixedAt ?? pr.openedAt;

/** Every moment the PR changes, for the clock to refresh the views on. */
export function heroBeatTimes(pr: HeroPr): number[] {
  const ci = runOf(pr)
    .flatMap((j) => [j.start, j.end])
    .map((b) => pushedAt(pr) + b * ms(pr));
  const comments = Object.values(BEATS).map((b) => pr.openedAt + b * ms(pr));
  const approval = pr.fixedAt !== null ? [pr.fixedAt + FIX_BEATS.approved * ms(pr)] : [];
  return [...ci, ...comments, ...approval];
}

function checkAt(job: CiJob, pushed: number, now: number, unit: number): PrCheck {
  const secs = (now - pushed) / unit;
  const started = pushed + job.start * unit;
  const done = secs >= job.end;
  const base = {
    name: job.name,
    url: `https://github.com/${HERO_REPO}/actions/runs/1204${job.jobId}`,
    steps: [],
    annotations: [],
    jobId: job.jobId,
    runId: 12_048,
    startedAt: secs >= job.start ? iso(started) : null,
    completedAt: done ? iso(pushed + job.end * unit) : null,
  };
  if (!done) {
    return {
      ...base,
      status: "Pending",
      description: secs < job.start ? "Queued" : `In progress · ${Math.floor(secs - job.start)}s`,
    };
  }
  return {
    ...base,
    status: job.outcome,
    description: job.note ?? `Successful in ${Math.round(job.end - job.start)}s`,
    ...(job.outcome === "Failure" ? job.failure : {}),
  };
}

export const heroChecks = (pr: HeroPr, now: number): "Pending" | "Failure" | "Success" => {
  const checks = runOf(pr).map((j) => checkAt(j, pushedAt(pr), now, ms(pr)));
  if (checks.some((c) => c.status === "Failure")) return "Failure";
  return checks.some((c) => c.status === "Pending") ? "Pending" : "Success";
};

export const heroHeadSha = (pr: HeroPr) =>
  pr.fixedAt === null
    ? "a91c2e4f7b3d5e6a8c0f1b2d3e4f5a6b7c8d9e0f"
    : "4c1e9a7d2b5f8e3a6c9d0b1e2f3a4b5c6d7e8f90";

/** Everything the PR shows at `now`: files, checks, comments as they arrive. */
export function heroPrDetail(pr: HeroPr, body: string, now: number): PrDetail {
  const since = (now - pr.openedAt) / ms(pr);
  const after = (beat: number) => since >= beat;
  const fixed = pr.fixedAt !== null;
  const sinceFix = fixed && pr.fixedAt !== null ? (now - pr.fixedAt) / ms(pr) : 0;
  const files = fixed ? HERO_V2 : HERO_V1;

  const checks = runOf(pr).map((job) => checkAt(job, pushedAt(pr), now, ms(pr)));

  const comments: PrComment[] = [];
  const threads: PrThread[] = [];
  const t = (beat: number) => pr.openedAt + beat * ms(pr);
  if (after(BEATS.daniel)) {
    comments.push(
      comment(
        PEOPLE.daniel,
        "Close — one blocking issue on the lease length.",
        t(BEATS.daniel),
        "Review",
        null,
        "ChangesRequested",
      ),
    );
    threads.push(
      thread(
        "PRRT_hero_lease",
        W,
        lineIn(WORKER_V1, "const LEASE_MS"),
        comment(PEOPLE.daniel, HERO_COMMENTS.daniel, t(BEATS.daniel), "ReviewThread", W),
        fixed,
      ),
    );
  }
  if (after(BEATS.aisha)) {
    threads.push(
      thread(
        "PRRT_hero_key",
        D,
        lineIn(DELIVER_V1, '"Idempotency-Key"'),
        comment(PEOPLE.aisha, HERO_COMMENTS.aisha, t(BEATS.aisha), "ReviewThread", D),
        fixed,
      ),
    );
  }
  if (after(BEATS.maya)) comments.push(comment(PEOPLE.maya, HERO_COMMENTS.maya, t(BEATS.maya)));
  if (fixed && pr.fixedAt !== null && sinceFix >= FIX_BEATS.approved) {
    comments.push(
      comment(
        PEOPLE.daniel,
        "Lease renewal looks right. Ship it.",
        pr.fixedAt + FIX_BEATS.approved * ms(pr),
        "Review",
        null,
        "Approved",
      ),
    );
  }

  const commit = (oid: string, headline: string, at: number) => ({
    oid,
    abbreviatedOid: oid.slice(0, 7),
    messageHeadline: headline,
    messageBody: "",
    author: ME,
    authorAvatarUrl: avatar(ME),
    committedDate: iso(at),
    url: `https://github.com/${HERO_REPO}/commit/${oid}`,
  });
  const commits = [
    commit(
      "a91c2e4f7b3d5e6a8c0f1b2d3e4f5a6b7c8d9e0f",
      "fix(webhooks): claim deliveries with a lease",
      pr.openedAt - 4 * SEC,
    ),
  ];
  if (fixed && pr.fixedAt !== null) {
    commits.push(
      commit(
        heroHeadSha(pr),
        "fix(webhooks): renew the lease, key per endpoint",
        pr.fixedAt - 3 * SEC,
      ),
    );
  }

  return {
    body,
    attachments: [],
    labels: [
      { name: "bug", color: "d73a4a", description: null },
      { name: "webhooks", color: "0ea5a4", description: null },
    ],
    comments,
    threads,
    files: files.map((f) => {
      const d = diffOf(f.oldText, f.newText);
      return {
        path: f.path,
        previousPath: null,
        status: f.oldText === "" ? "added" : "modified",
        additions: d.additions,
        deletions: d.deletions,
        patch: d.patch,
        sha: `${f.path.length.toString(16)}${f.newText.length.toString(16)}`.padEnd(40, "0"),
      };
    }),
    filesTruncated: false,
    commits,
    commitsTruncated: false,
    checks,
    baseSha: "0b3f7c1e9a2d4f6b8c0e1a3b5d7f9c2e4a6b8d0f",
    headSha: heroHeadSha(pr),
    pendingReviewId: null,
  };
}

export const heroPrFiles = (pr: HeroPr) => (pr.fixedAt === null ? HERO_V1 : HERO_V2);

/** Whether everything has landed: CI red, both threads and Maya's comment. */
export const heroPrSettled = (pr: HeroPr, now: number) =>
  (now - pr.openedAt) / ms(pr) >= BEATS.maya;

export const heroDecision = (pr: HeroPr, now: number) =>
  pr.fixedAt !== null && (now - pr.fixedAt) / ms(pr) >= FIX_BEATS.approved
    ? "Approved"
    : (now - pr.openedAt) / ms(pr) >= BEATS.daniel
      ? "ChangesRequested"
      : "ReviewRequired";

// ── The AI review ────────────────────────────────────────────────────────────

export function heroDrafts(agentKind: AgentKind, pr: HeroPr, now: number): ReviewDraft[] {
  const base = {
    agentKind,
    prRepo: HERO_REPO,
    prNumber: pr.number,
    headSha: heroHeadSha(pr),
    onRight: true,
    startLine: null,
    createdAtMs: now,
    updatedAtMs: now,
  };
  return [
    {
      ...base,
      id: "draft-hero-claim",
      path: W,
      line: lineIn(WORKER_V1, "await db.webhookDeliveries.updateMany("),
      body: "`claimDue()` selects due deliveries and then leases them in a second statement. Two workers can select the same row before either writes the lease — the exact duplicate this PR is fixing. Claim in one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`.",
      suggestion: null,
    },
    {
      ...base,
      id: "draft-hero-release",
      path: D,
      line: lineIn(DELIVER_V1, "lastError: String(err),"),
      body: "On a failed attempt the lease is left in place, so the retry waits out the remaining lease on top of the backoff — a 10s first retry becomes up to 40s. Clear `leaseUntil` when recording the failure.",
      suggestion: "      lastError: String(err),\n      leaseUntil: null,",
    },
    {
      ...base,
      id: "draft-hero-index",
      path: M,
      line: lineIn(MIGRATION_V1, "ADD COLUMN lease_until"),
      body: "The claim query now filters on `next_attempt_at` and `lease_until`. Without an index that's a sequential scan of `webhook_deliveries` every second on every worker. A partial index on `(next_attempt_at, lease_until) WHERE delivered_at IS NULL` keeps it cheap.",
      suggestion: null,
    },
  ];
}

export function heroBrief(agentKind: AgentKind, pr: HeroPr, now: number): ReviewBrief {
  return {
    agentKind,
    summary:
      "Stops duplicate webhook deliveries by leasing each delivery to one worker before sending it, and adds an Idempotency-Key header. The direction is right, but the claim is a select-then-update that two workers can still race, the 30s lease is shorter than the 45s request timeout, and failed attempts keep their lease. Both red checks come from this diff.",
    readingOrder: [
      {
        path: W,
        role: "coreLogic",
        why: "The claim and the lease — the fix itself, and where the race is.",
      },
      {
        path: D,
        role: "entryPoint",
        why: "The send: Idempotency-Key, and what happens to the lease on failure.",
      },
      { path: M, role: "config", why: "The lease column; no index for the new poll query." },
      { path: T, role: "test", why: "Slow-endpoint cases; the slower-than-the-lease one is red." },
      { path: DOCS, role: "trivial", why: "Documents the header for shippers." },
    ],
    watchOuts: [
      {
        path: W,
        line: lineIn(WORKER_V1, "updateMany("),
        kind: "correctness",
        note: "Select-then-update: two workers can claim the same delivery.",
      },
      {
        path: W,
        line: lineIn(WORKER_V1, "const LEASE_MS"),
        kind: "correctness",
        note: "The lease (30s) is shorter than the request timeout (45s).",
      },
      {
        path: D,
        line: lineIn(DELIVER_V1, "lastError"),
        kind: "performance",
        note: "A failed attempt keeps its lease, delaying the retry.",
      },
      { path: M, line: 3, kind: "performance", note: "No index for the claim query." },
    ],
    questions: [
      "Should the Idempotency-Key be unique per endpoint? Shippers with several endpoints would see one key on all of them.",
    ],
    truncated: false,
    headSha: heroHeadSha(pr),
    generatedAtMs: now,
  };
}

/** The line numbers the scripts' edits print, kept honest. */
export const HERO_LINES = {
  lease: lineIn(WORKER_V1, "const LEASE_MS"),
  key: lineIn(DELIVER_V1, '"Idempotency-Key"'),
};
