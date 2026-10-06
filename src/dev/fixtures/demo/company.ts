/**
 * The demo company: Parcelwise, a delivery-logistics SaaS — shippers send
 * parcels through its API, carriers report scans back, customers track them
 * live. Everything is invented; it only has to read as a real engineering org
 * on a screen recording.
 *
 * This file is the static half of the demo world: people, repos, the Linear
 * plan (projects, milestones, blockers) and ticket bodies. What changes while
 * the demo runs — worktrees appearing, commits, PRs, the queue — lives in
 * `state.ts`.
 */
import type { Priority, ProjectMilestoneRef, TaskStatus } from "../../../bindings";
import { avatarFor } from "../avatars";

// ── Time ─────────────────────────────────────────────────────────────────────

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** `YYYY-MM-DD`, `days` from now (local calendar). */
export function dateIn(now: number, days: number): string {
  const d = new Date(now + days * DAY);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

export const iso = (ms: number) => new Date(ms).toISOString();

// ── People ───────────────────────────────────────────────────────────────────

export const ME = "Santiago Toscanini";
export const ME_LOGIN = "stoscanini";

export const PEOPLE = {
  me: ME,
  maya: "Maya Chen",
  daniel: "Daniel Okafor",
  lucia: "Lucía Fernández",
  tom: "Tom Becker",
  priya: "Priya Raman",
  jonas: "Jonas Lindqvist",
  aisha: "Aisha Bello",
  ethan: "Ethan Brooks",
} as const;

export const LOGIN: Record<string, string> = {
  [ME]: ME_LOGIN,
  [PEOPLE.maya]: "mayachen",
  [PEOPLE.daniel]: "dokafor",
  [PEOPLE.lucia]: "luciaf",
  [PEOPLE.tom]: "tbecker",
  [PEOPLE.priya]: "priyar",
  [PEOPLE.jonas]: "jlindqvist",
  [PEOPLE.aisha]: "aishab",
  [PEOPLE.ethan]: "ebrooks",
};

/** Profile photos from the gitignored `avatars/` folder (`fetch-avatars.sh`),
 *  by file name; anyone without one gets an initials disc. */
const PHOTOS = import.meta.glob<string>("./avatars/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
});

const PHOTO_OF: Record<string, string> = {
  [ME]: "me",
  [PEOPLE.maya]: "maya",
  [PEOPLE.daniel]: "daniel",
  [PEOPLE.lucia]: "lucia",
  [PEOPLE.tom]: "tom",
  [PEOPLE.priya]: "priya",
  [PEOPLE.jonas]: "jonas",
  [PEOPLE.aisha]: "aisha",
  [PEOPLE.ethan]: "ethan",
};

export const avatar = (name: string): string =>
  PHOTOS[`./avatars/${PHOTO_OF[name]}.jpg`] ?? avatarFor(name);

// ── Repos ────────────────────────────────────────────────────────────────────

export const ORG = "parcelwise";
export const HOME = "/Users/santiago/dev/parcelwise";
export const PLATFORM = `${ORG}/platform`;
export const DRIVER = `${ORG}/driver-app`;
export const INFRA = `${ORG}/infra`;
export const DEMO_REPOS = [PLATFORM, DRIVER, INFRA] as const;

export const REPO_PATH: Record<string, string> = {
  [PLATFORM]: `${HOME}/platform`,
  [DRIVER]: `${HOME}/driver-app`,
  [INFRA]: `${HOME}/infra`,
};

export const isDemoRepo = (repo: unknown): boolean => typeof repo === "string" && repo in REPO_PATH;

/** Whether a filesystem path is inside the demo world (and not a real checkout). */
export const isDemoPath = (path: unknown): boolean =>
  typeof path === "string" && path.startsWith(`${HOME}/`);

export const worktreePath = (repo: string, id: string) =>
  `${REPO_PATH[repo]}/.santree/worktrees/${id}`;

export const LINEAR_ORG = { slug: "parcelwise", name: "Parcelwise" };

/** The Linear teams, by the prefix every ticket id carries. */
export const TEAMS: Record<string, string> = {
  PLAT: "Platform",
  DRV: "Driver App",
  INFRA: "Infrastructure",
};

export const REPO_TEAM: Record<string, string> = {
  [PLATFORM]: "PLAT",
  [DRIVER]: "DRV",
  [INFRA]: "INFRA",
};

// ── The Linear plan ──────────────────────────────────────────────────────────

export interface ProjectSeed {
  project: string;
  projectColor: string;
  projectIcon: string;
  targetDays: number;
  milestones: Record<string, { name: string; days: number; sortOrder: number }>;
}

export const TRACKING: ProjectSeed = {
  project: "Live Tracking",
  projectColor: "#5E6AD2",
  projectIcon: "🛰️",
  targetDays: 26,
  milestones: {
    pipeline: { name: "Event pipeline", days: 4, sortOrder: 1 },
    map: { name: "Customer map", days: 15, sortOrder: 2 },
    ga: { name: "GA", days: 26, sortOrder: 3 },
  },
};

export const API_V3: ProjectSeed = {
  project: "Public API v3",
  projectColor: "#DB2777",
  projectIcon: "🔌",
  targetDays: 34,
  milestones: {
    preview: { name: "Developer preview", days: 9, sortOrder: 1 },
    ga: { name: "GA", days: 34, sortOrder: 2 },
  },
};

export const RETURNS: ProjectSeed = {
  project: "Returns Portal",
  projectColor: "#0EA5A4",
  projectIcon: "📦",
  targetDays: 19,
  milestones: {
    beta: { name: "Beta", days: 7, sortOrder: 1 },
    ga: { name: "GA", days: 19, sortOrder: 2 },
  },
};

export const CARRIERS: ProjectSeed = {
  project: "Carrier Integrations",
  projectColor: "#D97706",
  projectIcon: "🚚",
  targetDays: 30,
  milestones: {
    fedex: { name: "FedEx", days: 11, sortOrder: 1 },
    dhl: { name: "DHL Express", days: 30, sortOrder: 2 },
  },
};

export const OFFLINE: ProjectSeed = {
  project: "Offline Mode",
  projectColor: "#7C3AED",
  projectIcon: "📶",
  targetDays: 21,
  milestones: {
    sync: { name: "Sync engine", days: 8, sortOrder: 1 },
    ga: { name: "GA", days: 21, sortOrder: 2 },
  },
};

export function milestoneRef(
  now: number,
  project: ProjectSeed,
  key: string,
): ProjectMilestoneRef | null {
  const m = project.milestones[key];
  if (!m) return null;
  return {
    id: `ms-${project.project.toLowerCase().replace(/\W+/g, "-")}-${key}`,
    name: m.name,
    targetDate: dateIn(now, m.days),
    sortOrder: m.sortOrder,
  };
}

export const CYCLE = (now: number) => ({
  number: 31,
  name: null,
  startsAtMs: now - 5 * DAY,
  endsAtMs: now + 9 * DAY,
});

export interface CommentSeed {
  by: string;
  agoMs: number;
  body: string;
}

export interface TicketSeed {
  id: string;
  title: string;
  priority: Priority;
  status: TaskStatus;
  estimate?: number;
  assignee?: string;
  blockedBy?: string[];
  project?: ProjectSeed;
  milestone?: string;
  inCycle?: boolean;
  dueDays?: number;
  labels?: string[];
  author?: string;
  createdAgo?: number;
  /** Markdown body, for the ticket pane. */
  body: string;
  comments?: CommentSeed[];
}

// ── Platform ─────────────────────────────────────────────────────────────────

const PLATFORM_TICKETS: TicketSeed[] = [
  // Live Tracking — the long chain the graph reads left to right.
  {
    id: "PLAT-401",
    title: "Ingest carrier scan events into the event bus",
    priority: "High",
    status: "InReview",
    estimate: 5,
    assignee: ME,
    project: TRACKING,
    milestone: "pipeline",
    inCycle: true,
    labels: ["backend", "tracking"],
    body: `Carriers post scan events to four different webhook shapes today and we poll two more. Land them all on the \`scan-events\` topic so everything downstream reads one stream.

## Scope

- One consumer per carrier adapter, publishing to \`scan-events\` keyed by tracking number
- At-least-once delivery; consumers must be idempotent on \`(carrier, scan_id)\`
- Dead-letter topic for payloads we can't parse

## Out of scope

Normalizing the payloads (PLAT-402).`,
    comments: [
      {
        by: PEOPLE.maya,
        agoMs: 2 * DAY,
        body: "Partition by tracking number, not carrier — otherwise one busy carrier serializes everything.",
      },
      { by: ME, agoMs: 2 * DAY - 3 * HOUR, body: "Agreed, switched the key." },
    ],
  },
  {
    id: "PLAT-402",
    title: "Normalize scan events to a canonical schema",
    priority: "High",
    status: "InReview",
    estimate: 3,
    assignee: ME,
    blockedBy: ["PLAT-401"],
    project: TRACKING,
    milestone: "pipeline",
    inCycle: true,
    labels: ["backend", "tracking"],
    body: `Every carrier has its own status vocabulary (UPS has 41 codes, DHL 63). Map them onto our \`ScanEvent\` schema so ETAs and the customer timeline only deal with one.

| Canonical | Examples |
|---|---|
| \`picked_up\` | UPS \`P\`, FedEx \`PU\`, DHL \`PU\` |
| \`in_transit\` | UPS \`I\`, FedEx \`IT\`, DHL \`PL\`, \`DF\` |
| \`out_for_delivery\` | UPS \`O\`, FedEx \`OD\`, DHL \`WC\` |
| \`exception\` | anything with a reason code |

Unknown codes go to \`in_transit\` with the raw code kept in \`carrier_status\`.`,
  },
  {
    id: "PLAT-404",
    title: "Backfill 90 days of scan history into the event bus",
    priority: "Medium",
    status: "InProgress",
    estimate: 3,
    assignee: ME,
    blockedBy: ["PLAT-402"],
    project: TRACKING,
    milestone: "pipeline",
    inCycle: true,
    labels: ["backend", "tracking"],
    body: "Replay the last 90 days of `shipment_scans` through the normalizer so the new timeline has history on day one. Batches of 5k, resumable from the last scan id, throttled so the live consumers keep up.",
  },
  {
    id: "PLAT-405",
    title: "Compute live ETAs from normalized scan events",
    priority: "High",
    status: "InProgress",
    estimate: 5,
    assignee: PEOPLE.maya,
    project: TRACKING,
    milestone: "map",
    inCycle: true,
    labels: ["backend", "tracking"],
    body: "Recompute a shipment's ETA on every scan: last hub, carrier service level, historical lane times. Store the estimate and its confidence on the shipment.",
  },
  {
    id: "PLAT-406",
    title: "Push ETA updates to customers over WebSockets",
    priority: "Medium",
    status: "Todo",
    estimate: 3,
    blockedBy: ["PLAT-405"],
    project: TRACKING,
    milestone: "map",
    labels: ["backend", "tracking"],
    body: "Replace the 30s poll on the tracking page with a subscription per tracking number. Fan out from the ETA service; reconnect with the last seen event id.",
  },
  {
    id: "PLAT-407",
    title: "Customer tracking map with live courier position",
    priority: "Medium",
    status: "Backlog",
    estimate: 5,
    assignee: PEOPLE.lucia,
    blockedBy: ["PLAT-406"],
    project: TRACKING,
    milestone: "map",
    labels: ["frontend", "tracking"],
    body: "The map from the Figma file (Tracking → Live map). Courier dot updates from the driver app's location pings once the parcel is out for delivery; before that, the last hub.",
  },
  {
    id: "PLAT-408",
    title: "Proof of delivery: photo and signature on the tracking page",
    priority: "Low",
    status: "Todo",
    estimate: 2,
    blockedBy: ["PLAT-406"],
    project: TRACKING,
    milestone: "map",
    labels: ["frontend", "tracking"],
    body: "Drivers already capture both (DRV-88). Show them on the tracking page once the parcel is delivered, behind a signed URL that expires after 7 days.",
  },
  {
    id: "PLAT-410",
    title: "Live Tracking GA checklist",
    priority: "Low",
    status: "Backlog",
    assignee: PEOPLE.daniel,
    project: TRACKING,
    milestone: "ga",
    body: "Load test at 3× peak, runbook, status page component, the changelog post and the email to enterprise shippers.",
  },

  // Public API v3.
  {
    id: "PLAT-409",
    title: "Rate-limit the public tracking API",
    priority: "Urgent",
    status: "InReview",
    estimate: 3,
    assignee: PEOPLE.daniel,
    project: API_V3,
    milestone: "preview",
    inCycle: true,
    dueDays: 1,
    labels: ["backend", "api"],
    author: PEOPLE.daniel,
    body: `A single shipper's integration hit \`GET /v3/tracking/:number\` 1,900 times a second during their sale on Friday and took p99 latency for everyone to 4s.

## What we want

- Token bucket **per API key**: 50 req/s sustained, bursts of 200
- \`429\` with \`Retry-After\` and the \`RateLimit-*\` headers from the IETF draft
- Enterprise keys get their limit from the plan, not a constant
- Buckets live in Redis so every API pod agrees

## Notes

The incident review is in Notion → Incidents → 2026-10-03 tracking latency.`,
    comments: [
      {
        by: PEOPLE.daniel,
        agoMs: 3 * DAY,
        body: "Please make sure the limiter fails open if Redis is down — I'd rather be slow than return 429 to everyone.",
      },
      {
        by: PEOPLE.priya,
        agoMs: 2 * DAY,
        body: "Support asked whether we can expose remaining quota in the dashboard. Out of scope here, but keep the counters readable.",
      },
    ],
  },
  {
    id: "PLAT-411",
    title: "Scoped API keys: read-only and per-resource permissions",
    priority: "High",
    status: "Todo",
    estimate: 5,
    blockedBy: ["PLAT-409"],
    project: API_V3,
    milestone: "preview",
    labels: ["backend", "api"],
    body: "Keys today are all-or-nothing. Add scopes (`tracking:read`, `shipments:write`, `labels:write`, `webhooks:manage`) and check them in the same middleware as the limiter.",
  },
  {
    id: "PLAT-412",
    title: "OpenAPI 3.1 spec and generated SDKs",
    priority: "Medium",
    status: "Backlog",
    estimate: 3,
    assignee: PEOPLE.ethan,
    project: API_V3,
    milestone: "ga",
    labels: ["api", "dx"],
    body: "Generate the spec from the route definitions, publish it, and generate the TypeScript, Python and Go SDKs in CI.",
  },
  {
    id: "PLAT-413",
    title: "v3 developer docs site",
    priority: "Medium",
    status: "Backlog",
    blockedBy: ["PLAT-412"],
    project: API_V3,
    milestone: "ga",
    labels: ["dx"],
    body: "Guides, the API reference from the spec, and a migration guide from v2.",
  },

  // Returns Portal.
  {
    id: "PLAT-415",
    title: "Refund rules engine for returns",
    priority: "High",
    status: "InProgress",
    estimate: 5,
    assignee: PEOPLE.priya,
    project: RETURNS,
    milestone: "beta",
    inCycle: true,
    labels: ["backend", "returns"],
    body: `Shippers configure when a return is refunded automatically and when it needs review.

- Rules evaluate in order; first match wins
- Conditions: days since delivery, order value, item category, customer return count
- Outcomes: \`refund\`, \`store_credit\`, \`manual_review\`, \`reject\`
- Every decision is logged with the rule that made it`,
  },
  {
    id: "PLAT-418",
    title: "Generate prepaid return labels",
    priority: "High",
    status: "Todo",
    estimate: 3,
    project: RETURNS,
    milestone: "beta",
    inCycle: true,
    labels: ["backend", "returns", "labels"],
    author: PEOPLE.priya,
    body: `When a return is approved, buy a prepaid label from the shipper's default carrier and email it to the customer as a PDF and a QR code.

- Reuse \`LabelService.purchase\` with \`direction: "return"\`
- The QR code is the carrier's drop-off code where they have one (UPS, FedEx), otherwise the label barcode
- Labels expire after 30 days; void them through the carrier API if unused

Mockup of the email is attached to the Figma file (Returns → Emails).`,
    comments: [
      {
        by: PEOPLE.priya,
        agoMs: DAY,
        body: "Shippers on the Starter plan don't have a default carrier set — fall back to USPS Ground Advantage for them.",
      },
    ],
  },
  {
    id: "PLAT-419",
    title: "Customer-facing return flow",
    priority: "Medium",
    status: "Todo",
    estimate: 5,
    assignee: PEOPLE.lucia,
    blockedBy: ["PLAT-415", "PLAT-418"],
    project: RETURNS,
    milestone: "beta",
    labels: ["frontend", "returns"],
    body: "Order lookup → pick items → reason → refund preview (from the rules engine) → label. Branded per shipper.",
  },
  {
    id: "PLAT-420",
    title: "Email customers when their return status changes",
    priority: "Low",
    status: "Backlog",
    estimate: 2,
    project: RETURNS,
    milestone: "ga",
    labels: ["returns"],
    body: "Received at warehouse, inspected, refunded. Uses the shipper's email branding.",
  },
  {
    id: "PLAT-422",
    title: "Returns Portal GA",
    priority: "Low",
    status: "Backlog",
    assignee: PEOPLE.priya,
    blockedBy: ["PLAT-420"],
    project: RETURNS,
    milestone: "ga",
    body: "Pricing page, help center articles, enable for all Growth and Enterprise shippers.",
  },

  // Carrier Integrations.
  {
    id: "PLAT-427",
    title: "FedEx rate quotes at checkout",
    priority: "High",
    status: "Todo",
    estimate: 3,
    project: CARRIERS,
    milestone: "fedex",
    inCycle: true,
    labels: ["backend", "carriers"],
    author: PEOPLE.tom,
    body: `Add FedEx to the rate-quote fan-out next to UPS and USPS.

- FedEx Rate API v1 (OAuth client credentials, token cached for its TTL)
- Map service types: Ground, Home Delivery, Express Saver, 2Day, Priority Overnight
- Respect the 3s budget of the quote endpoint — a slow carrier is dropped, not waited on

Sandbox credentials are in 1Password → Carriers → FedEx sandbox.`,
  },
  {
    id: "PLAT-428",
    title: "Buy FedEx labels",
    priority: "Medium",
    status: "Todo",
    estimate: 3,
    blockedBy: ["PLAT-427"],
    project: CARRIERS,
    milestone: "fedex",
    labels: ["backend", "carriers", "labels"],
    body: "Ship API, ZPL and PDF labels, void within 24h.",
  },
  {
    id: "PLAT-430",
    title: "DHL Express tracking webhooks",
    priority: "Medium",
    status: "InProgress",
    estimate: 2,
    assignee: PEOPLE.tom,
    project: CARRIERS,
    milestone: "dhl",
    labels: ["backend", "carriers", "tracking"],
    body: "Subscribe to DHL's push tracking and publish onto `scan-events` through the PLAT-401 adapter interface.",
  },
  {
    id: "PLAT-431",
    title: "DHL Express rate quotes",
    priority: "Low",
    status: "Backlog",
    estimate: 3,
    blockedBy: ["PLAT-430"],
    project: CARRIERS,
    milestone: "dhl",
    labels: ["backend", "carriers"],
    body: "Same shape as the FedEx quotes, against MyDHL API.",
  },

  // Bugs and loose ends — the rest of the ready work.
  {
    id: "PLAT-421",
    title: "Webhook retries deliver duplicate shipment events",
    priority: "Urgent",
    status: "Todo",
    estimate: 2,
    inCycle: true,
    dueDays: 0,
    labels: ["bug", "webhooks"],
    author: PEOPLE.aisha,
    body: `Shippers receive \`shipment.delivered\` two or three times when their endpoint is slow.

The retry worker re-sends anything without a \`delivered_at\`, but \`delivered_at\` is only written after the HTTP call returns. An endpoint that takes longer than the 10s visibility timeout gets the event again from a second worker while the first is still waiting.

## Expected

Each event is delivered once per endpoint unless the endpoint fails. Include an \`Idempotency-Key\` header so shippers can dedupe the retries we do send.`,
    comments: [
      {
        by: PEOPLE.aisha,
        agoMs: 6 * HOUR,
        body: "Two enterprise shippers reported this today. One of them refunds on `delivered`, so the duplicates cost them money.",
      },
      {
        by: PEOPLE.daniel,
        agoMs: 5 * HOUR,
        body: "Logs for one of them in Datadog: `service:webhooks @shipper_id:shp_8KQ2` — three deliveries 10s apart.",
      },
    ],
  },
  {
    id: "PLAT-424",
    title: "Address autocomplete drops apartment numbers",
    priority: "High",
    status: "Todo",
    estimate: 1,
    inCycle: true,
    labels: ["bug", "frontend", "checkout"],
    author: PEOPLE.jonas,
    body: `Picking a suggestion from the address autocomplete clears the "Apt / Suite" field, and customers don't notice. Carriers then return the parcel as undeliverable.

## Repro

1. Checkout → shipping address
2. Type "Apt 4B" in line 2
3. Start typing in line 1 and pick a suggestion
4. Line 2 is empty

Happens on every browser. The suggestion's \`subpremise\` is empty for most results and we overwrite line 2 with it.`,
  },
  {
    id: "PLAT-425",
    title: "Flaky: label PDF snapshot test on CI",
    priority: "Low",
    status: "Backlog",
    labels: ["flaky-test"],
    body: "Fails about one run in fifteen. The PDF embeds the generation timestamp; the snapshot should freeze the clock.",
  },
  {
    id: "PLAT-426",
    title: "Investigate: label purchase latency spikes at 9am ET",
    priority: "Medium",
    status: "Backlog",
    labels: ["investigation"],
    body: "p95 for `POST /labels` goes from 600ms to 3s for about twenty minutes every weekday morning. Carrier side or ours?",
  },
];

// ── Driver app ───────────────────────────────────────────────────────────────

const DRIVER_TICKETS: TicketSeed[] = [
  {
    id: "DRV-91",
    title: "Queue scans while offline and sync on reconnect",
    priority: "High",
    status: "InProgress",
    estimate: 5,
    assignee: ME,
    project: OFFLINE,
    milestone: "sync",
    inCycle: true,
    labels: ["mobile", "offline"],
    body: "Drivers in rural routes lose signal for twenty minutes at a time and their scans are lost. Persist scans locally and replay them in order when the connection comes back.",
  },
  {
    id: "DRV-92",
    title: "Conflict resolution for offline delivery updates",
    priority: "Medium",
    status: "Todo",
    estimate: 3,
    blockedBy: ["DRV-91"],
    project: OFFLINE,
    milestone: "sync",
    labels: ["mobile", "offline"],
    body: "If dispatch reassigns a stop while the driver is offline, the replayed scan has to lose.",
  },
  {
    id: "DRV-94",
    title: "Offline banner and pending-sync counter",
    priority: "Low",
    status: "Backlog",
    estimate: 1,
    assignee: PEOPLE.lucia,
    project: OFFLINE,
    milestone: "ga",
    labels: ["mobile"],
    body: "A banner when offline and a badge with the number of scans waiting to sync.",
  },
  {
    id: "DRV-88",
    title: "Capture signature on delivery",
    priority: "Medium",
    status: "InReview",
    estimate: 2,
    assignee: PEOPLE.jonas,
    labels: ["mobile"],
    body: "Signature pad on the delivery screen for parcels that require one.",
  },
  {
    id: "DRV-95",
    title: "Route list jumps to the top after every scan",
    priority: "Medium",
    status: "Backlog",
    estimate: 1,
    labels: ["bug", "mobile"],
    body: "The list re-renders from scratch on each scan and loses its scroll position.",
  },
];

// ── Infrastructure ───────────────────────────────────────────────────────────

const INFRA_TICKETS: TicketSeed[] = [
  {
    id: "INFRA-57",
    title: "Move Redis to a cluster with a replica per AZ",
    priority: "High",
    status: "InProgress",
    estimate: 3,
    assignee: PEOPLE.tom,
    inCycle: true,
    labels: ["infra"],
    body: "The rate limiter (PLAT-409) makes Redis load-bearing for the API. Three shards, one replica per AZ, failover tested.",
  },
  {
    id: "INFRA-60",
    title: "Kafka: raise retention on scan-events to 14 days",
    priority: "Medium",
    status: "Todo",
    estimate: 1,
    blockedBy: ["INFRA-57"],
    labels: ["infra", "tracking"],
    body: "The backfill (PLAT-404) needs room to replay.",
  },
  {
    id: "INFRA-62",
    title: "Alert on webhook delivery lag over 60s",
    priority: "Low",
    status: "Backlog",
    labels: ["infra", "observability"],
    body: "Page the on-call when the p95 lag between event and delivery stays above a minute for five minutes.",
  },
];

export const SEEDS: Record<string, TicketSeed[]> = {
  [PLATFORM]: PLATFORM_TICKETS,
  [DRIVER]: DRIVER_TICKETS,
  [INFRA]: INFRA_TICKETS,
};

export const ALL_TICKETS: TicketSeed[] = Object.values(SEEDS).flat();

export const ticketSeed = (id: string) => ALL_TICKETS.find((t) => t.id === id);

/** Which repo a ticket id belongs to, from its team prefix. */
export function repoOfTicket(id: string): string {
  const key = id.slice(0, id.indexOf("-"));
  return Object.entries(REPO_TEAM).find(([, k]) => k === key)?.[0] ?? PLATFORM;
}

/** A branch name the way santree derives one from a ticket. */
export function branchFor(id: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-");
  return `${ME_LOGIN}/${id.toLowerCase()}-${slug}`;
}
