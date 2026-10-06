/**
 * Live agent screens for the demo: a script per job, revealed step by step
 * against the time since the pane opened, with the CLI's own spinner ticking
 * underneath while it "works". Rendered in Claude Code's or Codex's grammar
 * depending on which agent the pane runs, so the same job reads right in
 * either — the agent pick is made live in the launch queue.
 */
import type { AgentKind } from "../../../bindings";
import {
  ask,
  bold,
  box,
  claude,
  claudeBanner,
  bash as claudeBash,
  edit as claudeEdit,
  tool as claudeTool,
  codexBanner,
  codexPrompt,
  codexSay,
  codexStep,
  contextBar,
  cyan,
  dim,
  green,
  magenta,
  red,
  say,
  styled,
  wrap,
} from "../transcript";

type DiffLine = { n: number; kind: " " | "+" | "-"; text: string };

export type Step =
  | { at: number; say: string }
  | { at: number; tool: string; arg: string; out?: string[] }
  | { at: number; mcp: string; arg: string; out?: string[] }
  | { at: number; edit: string; summary: string; lines?: DiffLine[] }
  | { at: number; bash: string; out: string[] }
  | { at: number; todos: string[]; done: number }
  /** A spinner caption change, nothing printed. */
  | { at: number; verb: string };

export interface Script {
  /** What the pasted prompt looks like folded: Claude's `[Pasted text #1 +N lines]`. */
  prompt: string;
  promptLines: number;
  steps: Step[];
  /** Printed once the last step is shown, if the job ends; omitted = still working. */
  final?: string;
  /** Seconds after which the job is over (the final message is up). */
  doneAt?: number;
  /** Context and spend at the end, for the status line. */
  contextPct: number;
  cost: string;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const SPIN = ["✻", "✶", "✳", "✢", "·", "✢", "✳", "✶"];

const codexStepLines = (s: Step): string[] => {
  if ("say" in s) return [];
  if ("tool" in s) return codexStep("Explored", [`${s.tool} ${s.arg}`, ...(s.out ?? [])]);
  if ("mcp" in s) return codexStep(`Called ${s.mcp}`, [s.arg, ...(s.out ?? [])]);
  if ("edit" in s)
    return codexStep("Edited", [`${s.edit} ${s.summary.replace(/^Updated \S+ with /, "(")}`]);
  if ("bash" in s)
    return [
      `${magenta("•")} ${bold("Ran")} ${s.bash}`,
      ...s.out.map((r, i) => {
        const t = r.startsWith("✓") ? green(r) : r.startsWith("✗") ? red(r) : dim(r);
        return i === 0 ? `  ${dim("└")} ${t}` : `    ${t}`;
      }),
    ];
  if ("todos" in s)
    return [
      `${magenta("•")} ${bold("Updated Plan")}`,
      ...s.todos.map((t, i) => {
        const mark = i < s.done ? green("✔") : dim("□");
        const text = i < s.done ? dim(t) : t;
        return `  ${i === 0 ? dim("└") : " "} ${mark} ${text}`;
      }),
    ];
  return [];
};

const claudeStepLines = (s: Step, width: number): string[] => {
  if ("say" in s) return say(s.say, width);
  if ("tool" in s) return claudeTool(s.tool, s.arg, s.out);
  if ("mcp" in s)
    return [
      `${claude("⏺")} ${bold(`linear - ${s.mcp} (MCP)`)}${dim("(")}${s.arg}${dim(")")}`,
      ...(s.out ?? []).map((r, i) => (i === 0 ? `  ${dim("⎿")}  ${dim(r)}` : `     ${dim(r)}`)),
    ];
  if ("edit" in s) return claudeEdit(s.edit, s.summary, s.lines ?? []);
  if ("bash" in s) return claudeBash(s.bash, s.out);
  if ("todos" in s)
    return [
      `${claude("⏺")} ${bold("Update Todos")}`,
      ...s.todos.map((t, i) => {
        const mark = i < s.done ? green("☒") : dim("☐");
        const text = i < s.done ? dim(`\x1b[9m${t}\x1b[29m`) : t;
        return `  ${i === 0 ? dim("⎿") : " "}  ${mark} ${text}`;
      }),
    ];
  return [];
};

function verbAt(script: Script, secs: number): string {
  let verb = "Thinking";
  for (const s of script.steps) {
    if (s.at > secs) break;
    if ("verb" in s) verb = s.verb;
  }
  return verb;
}

const fmtTokens = (secs: number) => {
  const k = Math.round(secs * 0.31 * 10) / 10;
  return k >= 1 ? `${k.toFixed(1)}k` : `${Math.round(secs * 310)}`;
};

function elapsedLabel(secs: number): string {
  const s = Math.floor(secs);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface ScreenCtx {
  kind: AgentKind;
  cwd: string;
  cols: number;
  rows: number;
  /** Seconds since the job started (may be negative-free; the pane clamps). */
  secs: number;
  /** Where the job's own clock started, for an agent that was mid-work at launch. */
  offset?: number;
}

export function isDone(script: Script, secs: number): boolean {
  return script.doneAt !== undefined && secs >= script.doneAt;
}

export function renderScreen(script: Script, ctx: ScreenCtx): string {
  const width = Math.max(40, ctx.cols);
  const secs = ctx.secs + (ctx.offset ?? 0);
  const visible = script.steps.filter((s) => s.at <= secs && !("verb" in s));
  const done = isDone(script, secs);
  const lines: string[] = [];

  // Where the spinner and composer start: they stay pinned to the bottom.
  let footerAt = 0;
  if (ctx.kind === "Codex") {
    lines.push(...codexBanner(ctx.cwd, width));
    lines.push(...ask(`[Pasted Content ${script.promptLines * 61} chars]`, width), "");
    for (const s of visible) {
      const out = "say" in s ? codexSay(s.say, width) : codexStepLines(s);
      if (out.length) lines.push(...out, "");
    }
    if (done && script.final) lines.push(...codexSay(script.final, width), "");
    footerAt = lines.length;
    if (!done) {
      lines.push(
        `${cyan("◦")} ${bold(verbAt(script, secs))} ${dim(`(${elapsedLabel(secs)} • esc to interrupt)`)}`,
      );
    }
    lines.push(
      ...codexPrompt(
        width,
        Math.max(
          12,
          100 - Math.round(script.contextPct * Math.min(1, secs / (script.doneAt ?? 240))),
        ),
      ),
    );
  } else {
    lines.push(...claudeBanner("Opus 5", ctx.cwd, width));
    lines.push(`${dim(">")} ${dim(`[Pasted text #1 +${script.promptLines} lines]`)}`, "");
    for (const s of visible) {
      const out = claudeStepLines(s, width);
      if (out.length) lines.push(...out, "");
    }
    if (done && script.final) lines.push(...say(script.final, width));
    footerAt = lines.length;
    if (!done) {
      const glyph = SPIN[Math.floor(secs * 4) % SPIN.length];
      lines.push(
        `${claude(glyph)} ${claude(`${verbAt(script, secs)}…`)} ${dim(`(${elapsedLabel(secs)} · ↓ ${fmtTokens(secs)} tokens · esc to interrupt)`)}`,
      );
    }
    const pct = Math.round(script.contextPct * Math.min(1, secs / (script.doneAt ?? 240)));
    lines.push(
      "",
      ...box([styled(` ${dim(">")} `)], width, dim),
      `  ${dim("⏵⏵ accept edits on (shift+tab to cycle)")}`,
      `  ${contextBar(pct, "Opus 5", script.cost, `${Math.round(pct * 2)}k / 200k`)}`,
    );
  }

  // The composer sits on the bottom rows and the conversation fills the space
  // above it, keeping only its latest lines once it outgrows the pane: writing
  // more rows than the pane has would scroll each repaint into the scrollback.
  const body = lines.slice(0, footerAt);
  const footer = lines.slice(footerAt);
  const room = Math.max(0, ctx.rows - 1 - footer.length);
  const shown =
    body.length >= room
      ? body.slice(body.length - room)
      : [...body, ...Array(room - body.length).fill("")];
  return `\x1b[2J\x1b[H${[...shown, ...footer].join("\r\n")}\x1b[?25l`;
}

// ── Shared beats ─────────────────────────────────────────────────────────────

const readTicket = (id: string, comments: number, attachments: string[] = []): Step[] => [
  { at: 1.2, verb: `Reading ${id}` },
  {
    at: 2.2,
    mcp: "get_issue",
    arg: `id: "${id}"`,
    out: [`${comments} comments · ${attachments.length} attachments · 2 related issues`],
  },
  ...attachments.map<Step>((a, i) => ({
    at: 3.4 + i * 0.9,
    tool: "Read",
    arg: `.santree/tickets/${id}/${a}`,
    out: ["Read image (312.4KB)"],
  })),
];

// ── The four parallel launches ───────────────────────────────────────────────

const PLAT_418: Script = {
  prompt: "PLAT-418",
  promptLines: 31,
  contextPct: 38,
  cost: "1.42",
  steps: [
    ...readTicket("PLAT-418", 1, ["return-label-email.png"]),
    {
      at: 5.4,
      say: "The email mockup has the QR code above the PDF link, and Priya's comment says Starter shippers have no default carrier — those fall back to USPS Ground Advantage. Let me look at how labels are bought today.",
    },
    { at: 6.5, verb: "Exploring the label service" },
    {
      at: 7.6,
      tool: "Search",
      arg: 'pattern: "purchase\\(", path: "src/labels"',
      out: ["Found 4 files"],
    },
    { at: 9.0, tool: "Read", arg: "src/labels/LabelService.ts", out: ["Read 214 lines"] },
    { at: 10.6, tool: "Read", arg: "src/carriers/adapter.ts", out: ["Read 96 lines"] },
    {
      at: 12.4,
      todos: [
        'Add direction: "return" to LabelService.purchase',
        "Resolve the carrier, falling back to USPS for Starter",
        "Render the QR code from the carrier's drop-off code",
        "Send the return-label email",
        "Void unused labels after 30 days",
        "Tests",
      ],
      done: 0,
    },
    { at: 13.5, verb: "Writing the return label flow" },
    {
      at: 16.0,
      edit: "src/labels/LabelService.ts",
      summary: "Updated src/labels/LabelService.ts with 24 additions and 3 removals",
      lines: [
        {
          n: 41,
          kind: " ",
          text: "  async purchase(shipment: Shipment, opts: PurchaseOptions = {}) {",
        },
        { n: 42, kind: "-", text: "    const carrier = this.carriers.for(shipment.shipperId);" },
        {
          n: 42,
          kind: "+",
          text: "    const carrier = await this.resolveCarrier(shipment.shipperId, opts.direction);",
        },
        {
          n: 43,
          kind: "+",
          text: '    const from = opts.direction === "return" ? shipment.to : shipment.from;',
        },
        {
          n: 44,
          kind: "+",
          text: '    const to = opts.direction === "return" ? shipment.returnTo : shipment.to;',
        },
      ],
    },
    {
      at: 19.0,
      todos: [
        'Add direction: "return" to LabelService.purchase',
        "Resolve the carrier, falling back to USPS for Starter",
        "Render the QR code from the carrier's drop-off code",
        "Send the return-label email",
        "Void unused labels after 30 days",
        "Tests",
      ],
      done: 2,
    },
    { at: 21.0, tool: "Write", arg: "src/returns/labelEmail.tsx", out: ["Wrote 88 lines"] },
    { at: 24.0, verb: "Wiring the QR code" },
    { at: 27.0, tool: "Write", arg: "src/returns/voidExpiredLabels.ts", out: ["Wrote 41 lines"] },
    { at: 31.0, verb: "Running the tests" },
    {
      at: 36.0,
      bash: "pnpm vitest run src/labels src/returns",
      out: [
        "✓ src/labels/LabelService.test.ts (14 tests) 302ms",
        "✓ src/returns/labelEmail.test.tsx (5 tests) 188ms",
        "Test Files  2 passed (2)",
      ],
    },
  ],
};

const PLAT_424: Script = {
  prompt: "PLAT-424",
  promptLines: 22,
  contextPct: 21,
  cost: "0.61",
  steps: [
    ...readTicket("PLAT-424", 0, ["autocomplete-repro.mp4.png"]),
    { at: 5.0, verb: "Finding the autocomplete handler" },
    {
      at: 6.0,
      tool: "Search",
      arg: 'pattern: "subpremise", path: "src/checkout"',
      out: ["Found 2 files"],
    },
    { at: 7.4, tool: "Read", arg: "src/checkout/useAutocomplete.ts", out: ["Read 132 lines"] },
    {
      at: 9.4,
      say: 'Found it: onSelect writes `line2: place.subpremise ?? ""` unconditionally, so a suggestion without a unit number wipes whatever the customer typed. It should only overwrite line 2 when the suggestion actually has one.',
    },
    { at: 11.0, verb: "Fixing onSelect" },
    {
      at: 12.6,
      edit: "src/checkout/useAutocomplete.ts",
      summary: "Updated src/checkout/useAutocomplete.ts with 1 addition and 1 removal",
      lines: [
        { n: 87, kind: " ", text: "      line1: place.streetAddress," },
        { n: 88, kind: "-", text: '      line2: place.subpremise ?? "",' },
        { n: 88, kind: "+", text: "      line2: place.subpremise || current.line2," },
        { n: 89, kind: " ", text: "      city: place.locality," },
      ],
    },
    {
      at: 15.0,
      tool: "Write",
      arg: "src/checkout/useAutocomplete.test.ts",
      out: ["Wrote 46 lines"],
    },
    { at: 17.0, verb: "Running the tests" },
    {
      at: 21.0,
      bash: "pnpm vitest run src/checkout",
      out: [
        "✓ src/checkout/useAutocomplete.test.ts (6 tests) 141ms",
        "  ✓ keeps line 2 when the suggestion has no subpremise",
        "Test Files  3 passed (3)",
      ],
    },
    { at: 23.0, verb: "Checking the other address forms" },
    {
      at: 25.0,
      tool: "Search",
      arg: 'pattern: "useAutocomplete", path: "src"',
      out: ["Found 3 files"],
    },
  ],
  doneAt: 31,
  final:
    "Fixed. Picking a suggestion no longer clears \"Apt / Suite\": line 2 is only replaced when the suggestion has its own subpremise. The returns portal and the dashboard's address editor use the same hook, so they're fixed too. Added a regression test for the repro in the ticket.",
};

/** The hero: done in under half a minute, its edits landing in Changes as
 *  they print (`state.ts` adds each file on its step). */
const PLAT_421: Script = {
  prompt: "PLAT-421",
  promptLines: 27,
  contextPct: 41,
  cost: "1.04",
  steps: [
    ...readTicket("PLAT-421", 2),
    {
      at: 3.6,
      say: "Daniel's logs show three deliveries ten seconds apart — exactly the visibility timeout. Checking the retry worker.",
    },
    { at: 4.4, verb: "Reading the retry worker" },
    { at: 5.0, tool: "Read", arg: "src/webhooks/retryWorker.ts", out: ["Read 24 lines"] },
    { at: 5.8, tool: "Read", arg: "src/webhooks/deliver.ts", out: ["Read 37 lines"] },
    {
      at: 7.4,
      say: "Confirmed: a delivery is only marked done after the HTTP call returns, so a second worker picks up a slow endpoint again. I'll have workers claim a delivery with a lease before sending, and add an Idempotency-Key header.",
    },
    {
      at: 8.8,
      todos: [
        "Lease column",
        "Claim deliveries before sending",
        "Idempotency-Key header",
        "Slow-endpoint tests",
        "Docs",
      ],
      done: 0,
    },
    { at: 9.4, verb: "Adding the delivery lease" },
    {
      at: 10.4,
      tool: "Write",
      arg: "db/migrations/0088_webhook_delivery_lease.sql",
      out: ["Wrote 3 lines"],
    },
    {
      at: 12.0,
      edit: "src/webhooks/retryWorker.ts",
      summary: "Updated src/webhooks/retryWorker.ts with 27 additions and 6 removals",
      lines: [
        { n: 4, kind: " ", text: "const BATCH = 100;" },
        { n: 5, kind: " ", text: "const POLL_MS = 1_000;" },
        { n: 6, kind: "+", text: "/** How long a worker owns a delivery it has claimed. */" },
        { n: 7, kind: "+", text: "const LEASE_MS = 30_000;" },
      ],
    },
    {
      at: 14.0,
      edit: "src/webhooks/deliver.ts",
      summary: "Updated src/webhooks/deliver.ts with 3 additions and 1 removal",
    },
    {
      at: 15.0,
      todos: [
        "Lease column",
        "Claim deliveries before sending",
        "Idempotency-Key header",
        "Slow-endpoint tests",
        "Docs",
      ],
      done: 3,
    },
    { at: 15.6, verb: "Writing slow-endpoint tests" },
    { at: 16.8, tool: "Write", arg: "src/webhooks/retryWorker.test.ts", out: ["Wrote 31 lines"] },
    {
      at: 18.0,
      edit: "docs/api/webhooks.md",
      summary: "Updated docs/api/webhooks.md with 6 additions",
    },
    { at: 18.6, verb: "Running the tests" },
    {
      at: 21.0,
      bash: "pnpm vitest run src/webhooks",
      out: [
        "✓ src/webhooks/retryWorker.test.ts (3 tests) 1.21s",
        "✓ src/webhooks/deliver.test.ts (7 tests) 204ms",
        "Test Files  2 passed (2)",
      ],
    },
  ],
  doneAt: 23,
  final:
    "Done. Workers now claim a delivery with a lease before sending it, so a slow endpoint is no longer picked up by a second worker, and every delivery carries an Idempotency-Key so shippers can drop the retries we do send. Added tests for endpoints slower than the poll interval and the lease. The changes are uncommitted for you to review.",
};

const PLAT_427: Script = {
  prompt: "PLAT-427",
  promptLines: 24,
  contextPct: 52,
  cost: "1.96",
  steps: [
    ...readTicket("PLAT-427", 0),
    { at: 4.0, verb: "Studying the UPS adapter" },
    { at: 5.0, tool: "Read", arg: "src/carriers/ups.ts", out: ["Read 241 lines"] },
    { at: 6.6, tool: "Read", arg: "src/carriers/adapter.ts", out: ["Read 96 lines"] },
    { at: 8.0, tool: "Search", arg: 'pattern: "QUOTE_BUDGET_MS"', out: ["Found 2 files"] },
    {
      at: 10.0,
      say: "UPS and USPS implement `CarrierAdapter.quote` and the fan-out drops anything slower than QUOTE_BUDGET_MS. FedEx needs an OAuth client-credentials token; I'll cache it for its TTL the way the UPS adapter does.",
    },
    {
      at: 12.0,
      todos: [
        "FedEx OAuth token, cached for its TTL",
        "Map FedEx service types",
        "Implement quote()",
        "Register in the fan-out",
        "Tests against recorded sandbox responses",
      ],
      done: 0,
    },
    { at: 13.0, verb: "Writing the FedEx adapter" },
    { at: 17.0, tool: "Write", arg: "src/carriers/fedex/auth.ts", out: ["Wrote 52 lines"] },
    { at: 21.0, tool: "Write", arg: "src/carriers/fedex/services.ts", out: ["Wrote 38 lines"] },
    {
      at: 23.0,
      todos: [
        "FedEx OAuth token, cached for its TTL",
        "Map FedEx service types",
        "Implement quote()",
        "Register in the fan-out",
        "Tests against recorded sandbox responses",
      ],
      done: 2,
    },
    { at: 26.0, tool: "Write", arg: "src/carriers/fedex/index.ts", out: ["Wrote 117 lines"] },
    { at: 30.0, verb: "Recording sandbox fixtures" },
  ],
};

// ── Agents already at work when the demo opens ───────────────────────────────

const PLAT_404: Script = {
  prompt: "PLAT-404",
  promptLines: 14,
  contextPct: 57,
  cost: "2.31",
  steps: [
    ...readTicket("PLAT-404", 0),
    { at: 4.0, tool: "Read", arg: "src/events/scanEvents.ts", out: ["Read 188 lines"] },
    { at: 6.0, tool: "Read", arg: "src/events/normalize.ts", out: ["Read 143 lines"] },
    {
      at: 9.0,
      todos: [
        "Batch reader over shipment_scans (5k rows)",
        "Resume from the last scan id",
        "Throttle on consumer lag",
        "Dry-run mode",
        "Tests",
      ],
      done: 2,
    },
    { at: 11.0, tool: "Write", arg: "src/events/backfill/throttle.ts", out: ["Wrote 47 lines"] },
    {
      at: 14.0,
      say: "The throttle reads consumer lag from the admin client and sleeps while lag is above 50k messages, so live traffic always wins.",
    },
    { at: 16.0, verb: "Adding the dry-run mode" },
    {
      at: 20.0,
      edit: "src/events/backfill/index.ts",
      summary: "Updated src/events/backfill/index.ts with 22 additions and 4 removals",
    },
    { at: 26.0, verb: "Running the backfill against the fixture DB" },
    {
      at: 40.0,
      bash: "pnpm backfill:scans --dry-run --days 90",
      out: [
        "scanned 1,204,880 rows in 241 batches",
        "would publish 1,198,412 events (6,468 duplicates skipped)",
        "max consumer lag 12,301 · throttled 0 times",
      ],
    },
  ],
};

const DRV_91: Script = {
  prompt: "DRV-91",
  promptLines: 12,
  contextPct: 33,
  cost: "0.00",
  steps: [
    ...readTicket("DRV-91", 0),
    { at: 4.0, tool: "Read", arg: "src/scan/useScanner.ts src/api/scans.ts", out: [] },
    {
      at: 8.0,
      say: "Scans are posted straight from the scanner callback, so with no signal they're dropped. I'll persist them to SQLite first and drain the queue in order when NetInfo reports a connection.",
    },
    { at: 10.0, verb: "Building the offline queue" },
    { at: 14.0, edit: "src/scan/queue.ts", summary: "Updated src/scan/queue.ts with 64 additions" },
    { at: 22.0, verb: "Wiring reconnect" },
  ],
};

// ── The PR's AI review and the queue run ─────────────────────────────────────

export function aiReviewScript(pr: number): Script {
  return {
    prompt: "review",
    promptLines: 48,
    contextPct: 31,
    cost: "0.94",
    steps: [
      { at: 0.8, verb: "Reading the review prompt" },
      { at: 1.6, tool: "Read", arg: `.santree/review-${pr}.md`, out: ["Read 48 lines"] },
      { at: 2.6, tool: "Read", arg: "src/webhooks/retryWorker.ts", out: ["Read 45 lines"] },
      { at: 3.4, tool: "Read", arg: "src/webhooks/deliver.ts", out: ["Read 39 lines"] },
      {
        at: 4.2,
        tool: "Read",
        arg: "db/migrations/0088_webhook_delivery_lease.sql",
        out: ["Read 3 lines"],
      },
      { at: 5.0, verb: "Reviewing" },
      {
        at: 6.6,
        say: "The lease is the right fix, but the claim is a select-then-update, so two workers can still take the same delivery. A failed attempt also keeps its lease, and the new poll query has no index.",
      },
      { at: 8.6, mcp: "set_review_brief", arg: "summary, 5 files in reading order, 4 watch-outs" },
      {
        at: 9.8,
        mcp: "add_review_comment",
        arg: "src/webhooks/retryWorker.ts — claim races between workers",
      },
      {
        at: 11.0,
        mcp: "add_review_comment",
        arg: "src/webhooks/deliver.ts — failed attempts keep their lease",
      },
      {
        at: 12.2,
        mcp: "add_review_comment",
        arg: "db/migrations/0088 — index for the claim query",
      },
    ],
    doneAt: 13.5,
    final:
      "Three draft comments and a brief are waiting in the AI work pane. Nothing was posted to GitHub.",
  };
}

/** A one-line plan entry for a queue item: its first sentence, trimmed. */
function todoOf(body: string): string {
  const first = body.split(/(?<=[.!?])\s|\n/)[0].replace(/^@\w+\s+/, "");
  return first.length > 64 ? `${first.slice(0, 61).trimEnd()}…` : first;
}

/** The "Start work" run, over whatever the queue holds when it starts. */
export function queueRunScript(items: string[], pr: number): Script {
  const todos = items.length ? items.map(todoOf) : ["Read the work queue"];
  const plan = (done: number): Step => ({ at: 0, todos, done });
  const at = (s: number, step: Step): Step => ({ ...step, at: s }) as Step;
  return {
    prompt: "pr-fix",
    promptLines: 30 + items.length * 3,
    contextPct: 47,
    cost: "1.38",
    steps: [
      { at: 0.8, verb: "Reading the work queue" },
      {
        at: 1.6,
        mcp: "list_review_work_items",
        arg: `pr: ${pr}`,
        out: [`${items.length} open items`],
      },
      at(2.4, plan(0)),
      { at: 3.0, tool: "Read", arg: "src/webhooks/retryWorker.ts", out: ["Read 45 lines"] },
      { at: 4.0, verb: "Claiming with one statement" },
      {
        at: 6.5,
        edit: "src/webhooks/retryWorker.ts",
        summary: "Updated src/webhooks/retryWorker.ts with 31 additions and 17 removals",
        lines: [
          {
            n: 15,
            kind: "-",
            text: "    await Promise.all(claimed.map((delivery) => deliver(delivery)));",
          },
          {
            n: 16,
            kind: "+",
            text: "    await Promise.all(claimed.map((delivery) => withLease(delivery.id, () => deliver(delivery))));",
          },
        ],
      },
      at(9.0, plan(Math.ceil(todos.length / 2))),
      { at: 9.5, verb: "Keying per endpoint" },
      {
        at: 10.6,
        edit: "src/webhooks/deliver.ts",
        summary: "Updated src/webhooks/deliver.ts with 4 additions and 1 removal",
      },
      {
        at: 11.6,
        edit: "db/migrations/0088_webhook_delivery_lease.sql",
        summary: "Updated db/migrations/0088_webhook_delivery_lease.sql with 5 additions",
      },
      { at: 12.6, bash: "pnpm db:types", out: ["Regenerated 41 table types"] },
      { at: 13.5, verb: "Running the checks" },
      {
        at: 16.0,
        bash: "pnpm typecheck && pnpm vitest run src/webhooks",
        out: [
          "✓ no type errors",
          "✓ src/webhooks/retryWorker.test.ts (3 tests) 1.34s",
          "✓ src/webhooks/deliver.test.ts (7 tests) 198ms",
          "Test Files  2 passed (2)",
        ],
      },
      at(17.5, plan(todos.length)),
      {
        at: 19.0,
        bash: "git diff --stat",
        out: [
          " db/migrations/0088_webhook_delivery_lease.sql |  5 ++",
          " docs/api/webhooks.md                          |  4 +-",
          " src/db/types/deliveries.ts                    |  3 +",
          " src/webhooks/deliver.ts                       |  5 +-",
          " src/webhooks/retryWorker.test.ts              |  2 +-",
          " src/webhooks/retryWorker.ts                   | 48 ++++++++------",
          " 6 files changed, 46 insertions(+), 21 deletions(-)",
        ],
      },
      { at: 20.0, mcp: "complete_review_work_item", arg: `${items.length} items` },
    ],
    doneAt: 21,
    final: `All ${items.length} queue items are addressed: one atomic claim, the lease renewed while a request is in flight, keys per endpoint, the index, and both failing checks pass locally. The changes are uncommitted for you to review and push.`,
  };
}

/** A job for any ticket the demo didn't script — someone clicked off-plan. */
function genericScript(id: string, title: string): Script {
  return {
    prompt: id,
    promptLines: 18,
    contextPct: 30,
    cost: "0.80",
    steps: [
      ...readTicket(id, 0),
      { at: 4.0, verb: "Exploring the codebase" },
      {
        at: 5.0,
        tool: "Search",
        arg: `pattern: "${title.split(" ").slice(-1)[0].toLowerCase()}"`,
        out: ["Found 5 files"],
      },
      {
        at: 7.0,
        say: `I'll start with the code paths "${title}" touches and write a plan before changing anything.`,
      },
      { at: 9.0, verb: "Planning" },
    ],
  };
}

export const SCRIPTS: Record<string, Script> = {
  "PLAT-418": PLAT_418,
  "PLAT-424": PLAT_424,
  "PLAT-421": PLAT_421,
  "PLAT-427": PLAT_427,
  "PLAT-404": PLAT_404,
  "DRV-91": DRV_91,
};

export function scriptFor(id: string, title: string): Script {
  return SCRIPTS[id] ?? genericScript(id, title);
}

// ── Setup script output ──────────────────────────────────────────────────────

/** What `.santree/init.sh` prints, chunk by chunk, with the delay before each. */
export function setupChunks(id: string, branch: string): { afterMs: number; text: string }[] {
  return [
    { afterMs: 80, text: `${dim("$")} .santree/init.sh\r\n` },
    { afterMs: 160, text: `${cyan("→")} Linking .env from the main checkout\r\n` },
    { afterMs: 220, text: `${cyan("→")} pnpm install --frozen-lockfile --prefer-offline\r\n` },
    { afterMs: 260, text: `${dim("Lockfile is up to date, resolution step is skipped")}\r\n` },
    {
      afterMs: 420,
      text: `${dim("Progress: resolved 1342, reused 1342, downloaded 0, added 1342, done")}\r\n`,
    },
    {
      afterMs: 180,
      text: `${dim("dependencies:")} ${green("+")} 214 packages ${dim("(hardlinked from the store)")}\r\n`,
    },
    { afterMs: 140, text: `${dim("Done in 1.4s")}\r\n` },
    {
      afterMs: 160,
      text: `${cyan("→")} Creating database ${bold(`parcelwise_${id.toLowerCase().replace("-", "_")}`)} from template\r\n`,
    },
    { afterMs: 380, text: `${dim("CREATE DATABASE")}\r\n` },
    { afterMs: 120, text: `${cyan("→")} pnpm db:migrate\r\n` },
    { afterMs: 340, text: `${dim("Applied 87 migrations (0001_init … 0087_return_rules)")}\r\n` },
    { afterMs: 160, text: `${cyan("→")} pnpm codegen\r\n` },
    { afterMs: 300, text: `${dim("Generated GraphQL types in 612ms")}\r\n` },
    { afterMs: 120, text: `${green("✓")} Worktree ready on ${magenta(branch)}\r\n` },
  ];
}

export { wrap };
