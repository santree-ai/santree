/**
 * Usage — what santree's work is spending, in the bar and in one panel.
 *
 * Two kinds of budget sit here. The **agent providers** meter time: their
 * account's windows (a short one — Claude's five hours, Codex's primary — and a
 * weekly one), each read as "how much is used, and when it resets". The
 * **services** (GitHub, Linear) meter calls — the API pools every Reviews
 * refresh and ticket sync draws on. They share a segment because they answer one
 * question ("what am I about to run out of?"), not because they are the same
 * number.
 *
 * The bar spells every provider window out beside the provider's mark, because
 * the number that binds is whichever one is nearly spent. The services get a
 * mark and nothing else: a pool with thousands of headroom is not worth the
 * width, so its numbers wait behind the click (see `ServiceBudgets`).
 *
 * The panel lists each provider on its own row — always both, a provider with
 * nothing to report saying so rather than vanishing — then each service that
 * actually answered, then the doors to the full history and the accounts. A
 * provider's row spells its windows out one per line, on the same `BudgetLine`
 * the services use: a window is a budget like any other, and three of them
 * crammed onto one line was the panel disagreeing with itself about how a
 * budget is drawn.
 *
 * Claude's windows have two sources and no third: Anthropic's own answer, and
 * the statusline payload the hook captures — both display-only, both recorded
 * into the same store (see COMPLIANCE.md). Whichever has windows is what shows;
 * with neither, the row says *why* rather than substituting some other number.
 * It used to stand a session's context fill in, which is a different quantity
 * from a different scope — the fullest session anywhere, against a weekly
 * account budget — and, by filling the row, it also silenced the explanation of
 * what was actually wrong. Codex's windows come from its app server.
 */
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";

import type { ClaudeRateLimitWindow, CodexRateLimits } from "../../../bindings";
import { formatUntil } from "../../../lib/format";
import {
  useClaudeAccountUsage,
  useClaudeGlobalCapture,
  useClaudeRateLimits,
  useCodexAccount,
  useCodexHealth,
  useCodexRateLimits,
} from "../../../lib/queries";
import { useLiveNow } from "../../../lib/relativeTime";
import { agentBrandColor } from "../../../theme/colors";
import { AgentIcon, ChevronRightIcon, RefreshIcon } from "../../icons";
import { Dropdown } from "../../primitives";
import { BudgetLine } from "./BudgetLine";
import {
  type ServiceBudget,
  ServiceBudgetRows,
  ServiceMarks,
  useServiceBudgets,
} from "./ServiceBudgets";
import { StatusButton } from "./StatusSegment";

type Kind = "Claude" | "Codex";

/** Warn/critical thresholds shared with the terminal bar and the tree status
 *  line, so one fill never reads as two different levels of urgent. Below the
 *  warn point the fill stays muted: an unremarkable meter should look like it. */
function meterColor(pct: number): string {
  if (pct >= 80) return "var(--color-status-red)";
  if (pct >= 60) return "var(--color-status-amber)";
  return "var(--color-muted-4)";
}

/** One rate-limit window, provider-neutral. */
interface Window {
  /** "5h", "wk", a model name — what the window is, in a word, for the bar. */
  label: string;
  /** The same thing spelled out, for the panel's labelled rows. */
  longLabel: string;
  pct: number;
  resetsAtMs: number | null;
}

interface ProviderUsage {
  kind: Kind;
  name: string;
  windows: Window[];
  /** Why there is nothing to show, when the provider itself said. */
  note: string | null;
}

/** The bar's fixed-width track — the panel's rows use the shared `BudgetLine`,
 *  whose track stretches; here the width has to be predictable, because the bar
 *  around it is a fixed budget of its own. */
function Meter({ pct }: { pct: number }) {
  return (
    <div className="h-[5px] w-12 flex-none overflow-hidden rounded-full bg-input">
      <div
        className="h-full rounded-full"
        style={{ width: `${pct}%`, background: meterColor(pct) }}
      />
    </div>
  );
}

/** "31% used 1h 38m" — a window as the bar spells it; the label rides along only
 *  when it isn't one of the two everyone has. */
function barText(w: Window, nowMs: number): string {
  const used = `${w.pct}% used`;
  // A model-scoped window (Fable, Opus) says which model instead of when it
  // resets: it rolls over with the weekly window whose countdown is already on
  // the bar, so repeating that time reads as two different deadlines.
  if (!isStandardWindow(w.label)) return `${used} ${w.label}`;
  return w.resetsAtMs ? `${used} ${formatUntil(w.resetsAtMs, nowMs)}` : used;
}

/** The two windows every account has, whose labels need no spelling out. */
function isStandardWindow(label: string): boolean {
  return label === "5h" || label === "wk";
}

/** A window's name spelled out, for a labelled row: "5h" is enough beside a bar
 *  three characters wide, but as the label column of its own row it reads like a
 *  truncation. A name that isn't a duration (a model's) is already a word. */
function spellOut(label: string): string {
  if (label === "wk") return "Weekly";
  const parsed = /^(\d+)([dhm])$/.exec(label);
  if (!parsed) return label;
  const n = Number(parsed[1]);
  if (parsed[2] === "m") return `${n} min`;
  const unit = parsed[2] === "d" ? "day" : "hour";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Claude's windows, by the names the CLI reports them under: the session and
 *  weekly ones first, then anything else (a per-model weekly window, say) by its
 *  own name with the `seven_day_` prefix dropped and the first letter raised. */
function claudeWindows(rows: ClaudeRateLimitWindow[] | undefined): Window[] {
  const order = ["five_hour", "seven_day"];
  const rank = (w: string) => (order.includes(w) ? order.indexOf(w) : 99);
  return (rows ?? [])
    .filter((r) => r.usedPct !== null)
    .sort((a, b) => rank(a.window) - rank(b.window) || a.window.localeCompare(b.window))
    .map((r) => {
      const bare = r.window.replace(/^seven_day_/, "");
      const label =
        r.window === "five_hour"
          ? "5h"
          : r.window === "seven_day"
            ? "wk"
            : bare.charAt(0).toUpperCase() + bare.slice(1);
      return {
        label,
        longLabel: spellOut(label),
        pct: Math.round(r.usedPct ?? 0),
        resetsAtMs: r.resetsAtMs,
      };
    });
}

/** Codex reports window length in minutes, and a weekly window is 10080 of them. */
function codexLabel(minutes: number | null, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes >= 10_000) return "wk";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function codexWindows(limits: CodexRateLimits | undefined): Window[] {
  if (!limits) return [];
  const out: Window[] = [];
  const pairs: [CodexRateLimits["primary"], string][] = [
    [limits.primary, "5h"],
    [limits.secondary, "wk"],
  ];
  for (const [w, fallback] of pairs) {
    if (!w || typeof w.usedPercent !== "number") continue;
    // Epoch seconds and epoch millis both appear on the wire, told apart by scale.
    const reset =
      w.resetsAt === null ? null : w.resetsAt < 10_000_000_000 ? w.resetsAt * 1_000 : w.resetsAt;
    const label = codexLabel(w.windowMinutes, fallback);
    out.push({
      label,
      longLabel: spellOut(label),
      pct: Math.min(100, Math.round(w.usedPercent)),
      resetsAtMs: reset,
    });
  }
  return out;
}

/** Every provider's usage, always both, in a fixed order. */
function useProviderUsage(): {
  providers: ProviderUsage[];
  refresh: () => void;
  fetching: boolean;
} {
  // Anthropic's own answer leads: it needs no session to have run, so it is
  // what fills the meters on a cold start. The stored rows (what the status
  // line captured) stand in while it loads — and are what the command itself
  // returns when there is no credential to ask with.
  const account = useClaudeAccountUsage();
  const stored = useClaudeRateLimits();
  const health = useCodexHealth();
  const codexAccount = useCodexAccount(health.data?.available === true);
  const codex = useCodexRateLimits(codexAccount.data?.connected === true);

  const providers = useMemo<ProviderUsage[]>(() => {
    // Not `account.data?.windows ?? stored.data`: an account read that failed —
    // rate-limited, signed out, offline — answers with an *empty* list, and `[]`
    // is not nullish, so that spelling silently shadowed the statusline rows and
    // defeated the whole point of having a second source.
    const fetched = claudeWindows(account.data?.windows);
    const claudeW = fetched.length > 0 ? fetched : claudeWindows(stored.data);
    // Only say why once Anthropic has actually been asked: "not signed in" is a
    // claim, and while the first read is in flight we don't know it yet. The
    // `detail` is the specific reason (an HTTP code, a transport error) and
    // never carries anything secret.
    const status = account.data?.status;
    const detail = account.data?.detail ?? null;
    const note =
      claudeW.length > 0 || !status
        ? null
        : status === "NoCredentials"
          ? "Sign in to Claude Code to see usage"
          : status === "Unauthorized"
            ? "Claude Code needs signing in again"
            : status === "Unavailable"
              ? (detail ?? "Anthropic didn't answer")
              : null;
    const codexW = codexWindows(codex.data);
    return [
      { kind: "Claude", name: "Claude", windows: claudeW, note },
      { kind: "Codex", name: "Codex", windows: codexW, note: null },
    ];
  }, [account.data, stored.data, codex.data]);

  return {
    providers,
    refresh: () => {
      void account.refetch();
      void codex.refetch();
    },
    fetching: account.isFetching || codex.isFetching,
  };
}

/** Optical sizing. The two marks are drawn to the same box but not to the same
 *  weight: OpenAI's knot is a solid shape that fills its viewBox, while Claude's
 *  asterisk is a thin radial star whose ink covers about two thirds of the same
 *  square. Rendered at one nominal size the Codex mark reads a good deal larger,
 *  which is what makes a column of provider rows look mis-indented even though
 *  every tile is identical. So each is scaled to match the other's ink. */
const GLYPH_SCALE: Record<Kind, number> = { Claude: 1.15, Codex: 0.86 };

function Mark({ kind, size = 11 }: { kind: Kind; size?: number }) {
  return (
    <span className="flex flex-none" style={{ color: agentBrandColor(kind) }}>
      <AgentIcon kind={kind} size={Math.round(size * GLYPH_SCALE[kind])} />
    </span>
  );
}

/** One provider in the bar: its mark, then — when it has anything — the fullest
 *  window's track and every window's text. */
function BarProvider({ p, nowMs }: { p: ProviderUsage; nowMs: number }) {
  if (p.windows.length === 0) return <Mark kind={p.kind} />;
  const pct = Math.min(100, Math.max(...p.windows.map((w) => w.pct)));
  return (
    <span className="flex items-center gap-1.5">
      <Mark kind={p.kind} />
      <Meter pct={pct} />
      <span className="flex items-center gap-1.5 text-[10.5px] tabular-nums whitespace-nowrap">
        {p.windows.map((w, i) => (
          <span key={w.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-muted-5">·</span>}
            <span style={w.pct >= 60 ? { color: meterColor(w.pct) } : undefined}>
              {barText(w, nowMs)}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** One provider's row in the panel: the mark and name, then a line per window —
 *  however many the account reports, never a fixed three.
 *
 *  Each window states its own reset, because each window *has* one: the 5-hour
 *  rolls hours before the weekly and per-model ones do. A single countdown on
 *  the name line was true enough while the windows shared one compact line and a
 *  single "soonest"; against a column of rows it reads as one deadline for all
 *  of them. */
function ProviderRow({
  p,
  nowMs,
  onOpen,
}: {
  p: ProviderUsage;
  nowMs: number;
  onOpen: () => void;
}) {
  const empty = p.windows.length === 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-hover"
    >
      <span className="flex items-center gap-2.5">
        {/* A tile, not a bare glyph: it fixes the icon column's width whatever
            the mark inside it is, and it is drawn *lighter* than the menu so it
            reads as a tile at all (the input tone is darker than this surface,
            which is why the marks used to float in the margin). */}
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-raised-2">
          <Mark kind={p.kind} size={13} />
        </span>
        <span className="text-[12.5px] font-semibold text-fg">{p.name}</span>
        {/* Titled as well as shown: a reason can be longer than the column (an
            HTTP code, a transport error), and truncating away the one actionable
            part of an empty row is how this went unexplained. Say why when the
            provider told us; "No usage data" alone leaves the user with nothing
            to do about it. */}
        {empty && (
          <span className="min-w-0 truncate text-[11px] text-muted-4" title={p.note ?? undefined}>
            {p.note ?? "No usage data"}
          </span>
        )}
        <ChevronRightIcon size={12} className="ml-auto flex-none text-muted-4" />
      </span>
      {!empty && (
        <span className="flex flex-col gap-1">
          {p.windows.map((w) => (
            <BudgetLine
              key={w.label}
              label={w.longLabel}
              pct={w.pct}
              // The provider thresholds, not the pools': a call budget goes
              // amber on how little is left, a time window on how much is spent.
              color={meterColor(w.pct)}
              value={`${w.pct}%`}
              resetsAtMs={w.resetsAtMs}
              nowMs={nowMs}
            />
          ))}
        </span>
      )}
    </button>
  );
}

function PanelLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg-2 hover:bg-hover"
    >
      <span className="flex-1">{label}</span>
      <ChevronRightIcon size={12} className="flex-none text-muted-4" />
    </button>
  );
}

/** The Usage panel: every provider's row, every service that answered, and the
 *  doors to the history and the accounts. */
function UsagePanel({
  providers,
  services,
  refresh,
  fetching,
  nowMs,
  close,
}: {
  providers: ProviderUsage[];
  services: ServiceBudget[];
  refresh: () => void;
  fetching: boolean;
  nowMs: number;
  close: () => void;
}) {
  const navigate = useNavigate();
  const capture = useClaudeGlobalCapture();
  const claudeEmpty = providers.some((p) => p.kind === "Claude" && p.windows.length === 0);
  // Claude's windows only arrive when a session redraws its status line. Until
  // santree wraps the user's global one, only sessions santree started count —
  // the one reason the row can sit empty while Claude is busy elsewhere.
  const offerCapture = claudeEmpty && capture.data !== undefined && !capture.data.enabled;
  const go = (section: string) => () => {
    close();
    navigate({ to: "/settings", search: { section } });
  };
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-[13px] font-semibold text-fg">Usage</span>
        {/* The scope note has to follow what is actually below it: with nothing
            connected this panel really is only the agents. */}
        <span className="ml-auto text-[11px] text-muted-4">
          {services.length > 0 ? "agents & services" : "all agents"}
        </span>
        <button
          type="button"
          onClick={refresh}
          aria-busy={fetching}
          aria-label="Refresh usage"
          title="Refresh"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-4 hover:bg-hover hover:text-fg-2"
        >
          <RefreshIcon size={12} className={fetching ? "animate-spin" : ""} />
        </button>
      </div>
      {/* Every block in this panel indents its *content* by the same 12px: the
          header text, each provider's tile, and the links below. The row blocks
          get there as 4px of container + 8px of row, so a hover fill can bleed
          past the text without moving the text itself. */}
      <div className="flex flex-col border-t border-line px-1 py-1">
        {providers.map((p) => (
          <ProviderRow key={p.kind} p={p} nowMs={nowMs} onOpen={go("usage")} />
        ))}
      </div>
      {/* The capture note explains the Claude row above it, so it stays next to
          it — the services follow. */}
      {offerCapture && (
        <div className="border-t border-line px-3 py-2 text-[11px] leading-[1.45] text-muted-3">
          Claude reports its limits through the status line, so only sessions started from santree
          count until you{" "}
          <button
            type="button"
            onClick={go("agents")}
            className="cursor-pointer text-fg-2 underline decoration-line-strong underline-offset-2 hover:text-fg"
          >
            capture from all Claude sessions
          </button>
          .
        </div>
      )}
      {/* Settings → Integrations, not → Usage: that is where these same pools are
          spelled out in full, beside the connection they belong to. */}
      <ServiceBudgetRows services={services} nowMs={nowMs} onOpen={go("integrations")} />
      <div className="flex flex-col border-t border-line px-1 py-1">
        <PanelLink label="Usage details & history" onClick={go("usage")} />
        <PanelLink label="Manage accounts…" onClick={go("agents")} />
      </div>
    </div>
  );
}

/** The bar's usage cluster, and the panel it opens. */
export function UsageSegment() {
  const [open, setOpen] = useState(false);
  const { providers, refresh: refreshProviders, fetching } = useProviderUsage();
  // Only while the panel is open: reading Linear's budget can cost a request
  // (it only reports one in a response), and the bar shows no service numbers
  // to keep fresh.
  const services = useServiceBudgets(open);
  const nowMs = useLiveNow();
  const summary = providers
    .filter((p) => p.windows.length > 0)
    .map((p) => `${p.name}: ${p.windows.map((w) => `${w.pct}% ${w.label}`).join(", ")}`)
    .join(" · ");
  const label = `${summary ? `Usage — ${summary}` : "Usage"} · GitHub and Linear API budgets`;
  const bar: ReactNode = providers.map((p) => <BarProvider key={p.kind} p={p} nowMs={nowMs} />);
  const busy = fetching || services.fetching;
  const refresh = () => {
    refreshProviders();
    // A manual refetch runs whatever `enabled` says, so refreshing a shut panel
    // would spend a Linear request on numbers nobody is looking at.
    if (open) services.refresh();
  };

  return (
    <>
      <Dropdown
        placement="up"
        open={open}
        onOpenChange={setOpen}
        menuClassName="w-[376px] overflow-hidden p-0"
        trigger={(toggle) => (
          <StatusButton onClick={toggle} title={label} aria-label={label}>
            <span className="flex items-center gap-2.5">
              {bar}
              {/* A hairline, not another gap: the marks after it are a different
                  kind of budget (calls, not time) and carry no numbers, so
                  without a break they read as a third provider. */}
              <span aria-hidden className="h-3 w-px flex-none bg-line" />
              <ServiceMarks />
            </span>
          </StatusButton>
        )}
      >
        {(close) => (
          <UsagePanel
            providers={providers}
            services={services.services}
            refresh={refresh}
            fetching={busy}
            nowMs={nowMs}
            close={close}
          />
        )}
      </Dropdown>
      <StatusButton
        onClick={refresh}
        aria-busy={busy}
        aria-label="Refresh usage"
        title="Refresh usage"
      >
        <RefreshIcon size={10} className={busy ? "animate-spin" : ""} />
      </StatusButton>
    </>
  );
}
