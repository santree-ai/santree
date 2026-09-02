/**
 * What the fake terminals show: a coding agent's screen, painted from a short
 * script into the pane's xterm. Rendered at the pane's own width, so a resize
 * repaints it the way a real TUI would.
 *
 * The look follows the CLIs closely enough to read as them at a glance — the
 * `⏺` / `⎿` grammar of Claude Code, Codex's `›` / `•` — without pretending to
 * be a byte-for-byte recording.
 */
import type { TranscriptKind } from "./world";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const paint = (codes: string, s: string) => `${ESC}${codes}m${s}${RESET}`;
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const cyan = (s: string) => paint("36", s);
const blue = (s: string) => paint("34", s);
const yellow = (s: string) => paint("33", s);
const magenta = (s: string) => paint("35", s);
const claude = (s: string) => paint("38;2;217;119;87", s);

/** Word-wrap plain prose to `width`, every line after the first indented. */
function wrap(text: string, width: number, indent = ""): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(" ");
    let line = "";
    const limit = Math.max(20, width);
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > limit - (out.length > 0 || line ? indent.length : 0) && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.map((l, i) => (i === 0 ? l : indent + l));
}

/** A styled line and its visible width — ANSI escapes are invisible on
 *  screen but count for `.length`, so a box can't measure its rows itself. */
interface Styled {
  text: string;
  visible: number;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point — this strips ANSI escapes to measure text.
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleWidth = (s: string) => s.replace(ANSI, "").length;
const plain = (s: string): Styled => ({ text: s, visible: s.length });
const styled = (text: string): Styled => ({ text, visible: visibleWidth(text) });

/** A rounded box across `width` columns. */
function box(lines: Styled[], width: number, tint = (s: string) => s): string[] {
  const inner = Math.max(10, width - 2);
  const pad = (s: string, visible: number) => s + " ".repeat(Math.max(0, inner - visible));
  return [
    tint(`╭${"─".repeat(inner)}╮`),
    ...lines.map(({ text, visible }) => `${tint("│")}${pad(text, visible)}${tint("│")}`),
    tint(`╰${"─".repeat(inner)}╯`),
  ];
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function claudeBanner(model: string, cwd: string, width: number): string[] {
  const home = cwd.replace("/Users/sam", "~");
  return [
    `${claude(" ▐▛███▜▌")}   ${bold("Claude Code")} ${dim("v2.1.34")}`,
    `${claude("▝▜█████▛▘")}  ${model} ${dim("·")} ${dim("Claude Max")}`,
    `${claude("  ▘▘ ▝▝")}    ${dim(home.length > width - 12 ? `…${home.slice(-(width - 14))}` : home)}`,
    "",
  ];
}

const user = (text: string, width: number) =>
  wrap(text, width - 2, "  ").map((l, i) => (i === 0 ? `${dim(">")} ${l}` : l));

const say = (text: string, width: number) =>
  wrap(text, width - 2, "  ").map((l, i) => (i === 0 ? `${claude("⏺")} ${l}` : l));

const tool = (name: string, arg: string, results: string[] = []) => [
  `${claude("⏺")} ${bold(name)}${dim("(")}${arg}${dim(")")}`,
  ...results.map((r, i) => (i === 0 ? `  ${dim("⎿")}  ${dim(r)}` : `     ${dim(r)}`)),
];

const edit = (
  file: string,
  summary: string,
  lines: { n: number; kind: " " | "+" | "-"; text: string }[],
) => [
  `${claude("⏺")} ${bold("Update")}${dim("(")}${file}${dim(")")}`,
  `  ${dim("⎿")}  ${dim(summary)}`,
  ...lines.map(({ n, kind, text }) => {
    const num = dim(String(n).padStart(8));
    if (kind === "+") return `${num} ${green(`+ ${text}`)}`;
    if (kind === "-") return `${num} ${red(`- ${text}`)}`;
    return `${num}   ${dim(text)}`;
  }),
];

const bash = (cmd: string, results: string[]) => [
  `${claude("⏺")} ${bold("Bash")}${dim("(")}${cmd}${dim(")")}`,
  ...results.map((r, i) => {
    const t = r.startsWith("✓")
      ? `${green("✓")}${r.slice(1)}`
      : r.startsWith("✗")
        ? `${red("✗")}${r.slice(1)}`
        : dim(r);
    return i === 0 ? `  ${dim("⎿")}  ${t}` : `     ${t}`;
  }),
];

function claudePrompt(width: number, status: string, hint: string): string[] {
  return ["", ...box([styled(` ${dim(">")} `)], width, dim), `  ${dim(hint)}`, `  ${status}`];
}

const contextBar = (pct: number, model: string, cost: string, extra = "") => {
  const filled = Math.round(pct / 10);
  const bar = green("▰".repeat(filled)) + dim("▱".repeat(10 - filled));
  return `${dim(model)} ${dim("·")} ${bar} ${pct}% ${dim("·")} ${dim(extra || `$${cost}`)}`;
};

function permission(width: number): string[] {
  const inner = width - 2;
  const row = (s: string) => styled(` ${s}`);
  return box(
    [
      row(bold("Bash command")),
      row(""),
      row(`  ${cyan("pnpm db:migrate --dry-run")}`),
      row(`  ${dim("Check the pond_v2 migration against the staging schema")}`),
      row(""),
      row("Do you want to proceed?"),
      row(`${claude("❯")} 1. Yes`),
      row("  2. Yes, and don't ask again for pnpm commands in this worktree"),
      row(`  3. No, and tell Claude what to do differently ${dim("(esc)")}`),
    ].map((s) => (s.visible > inner ? styled(s.text.slice(0, inner)) : s)),
    width,
    yellow,
  );
}

function claudeFix(width: number): string[] {
  const cwd = "/Users/sam/dev/mallard-labs/quackstack/.santree/worktrees/QK-142";
  return [
    ...claudeBanner("Opus 5", cwd, width),
    ...user(
      "Ducks render upside down in Safari — find out why and fix it. Ticket QK-142 is attached; the repro is in the description.",
      width,
    ),
    "",
    ...say("I'll start with where the pond draws its ducks.", width),
    "",
    ...tool("Search", 'pattern: "rotate", path: "src/pond"', ["Found 3 files (ctrl+o to expand)"]),
    "",
    ...tool("Read", "src/pond/DuckLayer.tsx", ["Read 148 lines"]),
    "",
    ...say(
      "Found it. DuckLayer flips a sprite with rotate(180deg) whenever its heading is negative, and bearing() in geometry.ts passes atan2 its arguments the wrong way round — so every duck facing west gets a negative heading. Chrome masks it by normalising the transform; Safari doesn't.",
      width,
    ),
    "",
    ...edit("src/pond/geometry.ts", "Updated src/pond/geometry.ts with 1 addition and 1 removal", [
      { n: 10, kind: " ", text: "export function bearing(from: Point, to: Point): number {" },
      { n: 11, kind: "-", text: "  return Math.atan2(to.x - from.x, to.y - from.y);" },
      { n: 11, kind: "+", text: "  return Math.atan2(to.y - from.y, to.x - from.x);" },
      { n: 12, kind: " ", text: "}" },
    ]),
    "",
    ...bash("pnpm vitest run src/pond/geometry.test.ts", [
      "✓ src/pond/geometry.test.ts (7 tests) 212ms",
      "  ✓ bearing › keeps a westward duck upright",
      "Test Files  1 passed (1)",
      "     Tests  7 passed (7)",
    ]),
    "",
    ...say(
      'Fixed. bearing() had its atan2 arguments swapped, so every westward duck got a negative heading and the rotate branch flipped it — only Safari showed it because Chrome normalises the transform. I added a regression test for the westward case; the same bearing() feeds the ripple direction, so the ripples point the right way now too.\n\nWant me to commit this as "fix(pond): keep westward ducks upright"?',
      width,
    ),
    ...claudePrompt(
      width,
      contextBar(42, "Opus 5", "1.87", "84k / 200k · $1.87"),
      "⏵⏵ accept edits on (shift+tab to cycle)",
    ),
  ];
}

function claudePermission(width: number): string[] {
  const cwd = "/Users/sam/dev/mallard-labs/quackstack/.santree/worktrees/QK-138";
  return [
    ...claudeBanner("Opus 5", cwd, width),
    ...user(
      "CI is red on the backfill test in PR #418 and Ada wants the backfill batched. Fix both, don't push.",
      width,
    ),
    "",
    ...tool("Read", "src/pond/events.test.ts", ["Read 188 lines"]),
    "",
    ...tool("Read", "migrations/0042_pond_v2.sql", ["Read 18 lines"]),
    "",
    ...say(
      "The test expects three legacy ponds and gets two: the backfill joins through ducks, so a pond with no ducks never makes it across. Ada's batching point is the same INSERT — I'll rewrite it as a batched, resumable job in backfill.ts and leave the migration to create the schema only.",
      width,
    ),
    "",
    ...edit(
      "src/pond/backfill.ts",
      "Updated src/pond/backfill.ts with 34 additions and 6 removals",
      [],
    ),
    "",
    ...edit(
      "migrations/0042_pond_v2.sql",
      "Updated migrations/0042_pond_v2.sql with 1 addition and 5 removals",
      [],
    ),
    "",
    ...say(
      "Before I run the tests I want to check the migration still applies cleanly against the staging schema.",
      width,
    ),
    "",
    ...permission(width),
    "",
    `  ${contextBar(61, "Opus 5", "3.40", "122k / 200k · $3.40")}`,
  ];
}

function claudeInvestigate(width: number): string[] {
  return [
    ...claudeBanner("Opus 5", "/Users/sam/dev/mallard-labs/quackstack", width),
    ...user(
      "Investigate QK-203: the bread dispenser returns 500 when a pond's crumb budget is exactly zero. Find the cause, don't change anything, and draft a reply for the ticket.",
      width,
    ),
    "",
    ...tool("Search", 'pattern: "ratio", path: "src/bread"', ["Found 2 files"]),
    "",
    ...tool("Read", "src/bread/meter.ts", ["Read 121 lines"]),
    "",
    ...say(
      "meter() divides the remaining budget by the daily allowance to get a ratio, and a zero budget makes that 0/0 — NaN. The guard on the next line only checks for Infinity, so NaN flows into the tier lookup and `tiers[NaN]` is undefined, hence `reading 'ratio'`. Negative budgets pass because -1/allowance is a real number.",
      width,
    ),
    "",
    ...bash("pnpm vitest run src/bread/meter.test.ts -t zero", [
      "✗ meter › zero budget returns the empty tier",
      "  TypeError: Cannot read properties of undefined (reading 'ratio')",
      "Test Files  1 failed (1)",
    ]),
    "",
    ...say(
      "That reproduces it. Drafting the reply for the ticket now — root cause, the one-line guard, and the two callers that need the same treatment.",
      width,
    ),
    ...claudePrompt(
      width,
      contextBar(28, "Opus 5", "0.58", "56k / 200k · $0.58"),
      "⏵⏵ accept edits on (shift+tab to cycle)",
    ),
  ];
}

function claudeIdle(width: number, cwd: string): string[] {
  return [
    ...claudeBanner("Opus 5", cwd, width),
    ...claudePrompt(width, contextBar(0, "Opus 5", "0.00", "0 / 200k"), "? for shortcuts"),
  ];
}

// ── Codex ────────────────────────────────────────────────────────────────────

function codexBanner(cwd: string, width: number): string[] {
  const home = cwd.replace("/Users/sam", "~");
  return [
    ...box(
      [
        styled(` ${bold(">_ OpenAI Codex")} ${dim("(v0.151.0)")}`),
        plain(""),
        styled(` ${dim("model:")}     gpt-5.6-sol   ${dim("/model to change")}`),
        styled(` ${dim("directory:")} ${home}`),
      ],
      width,
      dim,
    ),
    "",
  ];
}

const ask = (text: string, width: number) =>
  wrap(text, width - 2, "  ").map((l, i) => (i === 0 ? `${bold("›")} ${l}` : l));

const codexSay = (text: string, width: number) =>
  wrap(text, width - 2, "  ").map((l, i) => (i === 0 ? `${magenta("•")} ${l}` : l));

const codexStep = (title: string, details: string[]) => [
  `${magenta("•")} ${bold(title)}`,
  ...details.map((d, i) => (i === 0 ? `  ${dim("└")} ${dim(d)}` : `    ${dim(d)}`)),
];

const codexPrompt = (width: number, contextLeft: number) => [
  "",
  `${bold("›")} ${dim("Ask Codex to do anything")}`,
  "",
  `  ${dim("⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit")}${" ".repeat(Math.max(1, width - 62))}${dim(`${contextLeft}% context left`)}`,
];

function codexDarkMode(width: number): string[] {
  return [
    ...codexBanner("/Users/sam/dev/mallard-labs/quackstack/.santree/worktrees/QK-127", width),
    ...ask(
      "Add a dark theme to the pond dashboard. Every colour should come from src/theme/tokens.ts — no hex in components.",
      width,
    ),
    "",
    ...codexSay("I'll look at how the dashboard picks its colours today.", width),
    "",
    ...codexStep("Explored", [
      "Read src/dashboard/Pond.tsx, src/theme/tokens.ts",
      "Search #[0-9a-f]{6} in src/dashboard",
    ]),
    "",
    ...codexSay(
      "Forty-one hardcoded hex values across six files, most of them the same eight colours. I'll add a dark palette to the tokens and route the components through it.",
      width,
    ),
    "",
    ...codexStep("Edited", [
      "src/theme/tokens.ts (+48 −2)",
      "src/theme/dark.ts (new)",
      "src/dashboard/Pond.tsx (+34 −21)",
    ]),
    "",
    ...codexStep("Ran pnpm vitest run src/dashboard", ["12 passed"]),
    "",
    ...codexStep("Delegating to a subagent", [
      "audit the remaining files in src/dashboard for hex values and report each one with its nearest token",
    ]),
    `  ${dim("└")} ${blue("● working")} ${dim("(2m 14s)")}`,
    ...codexPrompt(width, 65),
  ];
}

function codexReview(width: number): string[] {
  return [
    ...codexBanner("/Users/sam/dev/mallard-labs/quackstack", width),
    ...ask(
      "Review pull request #417 (Rate-limit crumb requests per duck). Read the prompt in .santree/review-417.md and use the santree review tools for your findings.",
      width,
    ),
    "",
    ...codexStep("Explored", [
      "Read .santree/review-417.md",
      "Read src/bread/rateLimit.ts, src/bread/dispenser.ts, src/bread/rateLimit.test.ts",
    ]),
    "",
    ...codexSay(
      "The bucket is sound in the common case. Two things worth a comment: refilledAt advances even when no token is credited, and an unrelated change to crumbKind rode along.",
      width,
    ),
    "",
    ...codexStep("Called set_review_brief", [
      "summary, 4 files in reading order, 3 watch-outs, 1 question",
    ]),
    "",
    ...codexStep("Called add_review_comment", [
      "src/bread/rateLimit.ts:24 — refill clock advances without credit",
    ]),
    "",
    ...codexStep("Called add_review_comment", [
      "src/bread/dispenser.ts:112 — unrelated sourdough change, with a suggestion",
    ]),
    "",
    ...codexSay("Two drafts are waiting in the AI work pane. Nothing was posted to GitHub.", width),
    ...codexPrompt(width, 71),
  ];
}

// ── Shell ────────────────────────────────────────────────────────────────────

function shell(width: number, cwd: string, branch: string): string[] {
  const home = cwd.replace("/Users/sam", "~");
  const promptLine = `${blue(home)} ${dim("on")} ${magenta(` ${branch}`)} ${yellow("[!]")}`;
  return [
    promptLine,
    `${green("❯")} pnpm vitest run src/pond`,
    "",
    ` ${green("✓")} src/pond/geometry.test.ts ${dim("(7 tests)")} 212ms`,
    ` ${green("✓")} src/pond/ripples.test.ts ${dim("(4 tests)")} 98ms`,
    "",
    ` ${dim("Test Files")}  ${green("2 passed")} ${dim("(2)")}`,
    `      ${dim("Tests")}  ${green("11 passed")} ${dim("(11)")}`,
    `   ${dim("Duration")}  1.02s`,
    "",
    promptLine,
    `${green("❯")} ${paint("7", " ")}`,
  ].map((l) => (l.length > width * 3 ? l.slice(0, width * 3) : l));
}

// ── Entry ────────────────────────────────────────────────────────────────────

export function renderTranscript(
  kind: TranscriptKind,
  cols: number,
  ctx: { cwd: string; branch: string },
): string {
  const width = Math.max(40, cols);
  const lines = (() => {
    switch (kind) {
      case "claude-fix":
        return claudeFix(width);
      case "claude-permission":
        return claudePermission(width);
      case "claude-investigate":
        return claudeInvestigate(width);
      case "claude-idle":
        return claudeIdle(width, ctx.cwd);
      case "codex-dark-mode":
        return codexDarkMode(width);
      case "codex-review":
        return codexReview(width);
      case "shell":
        return shell(width, ctx.cwd, ctx.branch);
    }
  })();
  // Clear, home, the screen, then hide the cursor: a block cursor parked after
  // the status line reads as a stray glyph, and the prompt box is the cue.
  return `${ESC}2J${ESC}H${lines.join("\r\n")}${ESC}?25l`;
}
