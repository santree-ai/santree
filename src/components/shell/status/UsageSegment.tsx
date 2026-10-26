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
 * A provider with more than one login (Settings → Agents) shows only the one new
 * sessions use in the bar — named, unless it is the Default — and every login in
 * the panel, where a click on one makes it the account the next session starts
 * on. That is the whole switcher: one place, behind the number you check before
 * starting work. A running tab never moves from here (that is its own
 * "Continue on …"), and santree never switches on its own (COMPLIANCE.md,
 * "Agent accounts") — when the chosen login is nearly spent, the one with the
 * most room left only says so.
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

import type { AgentAccount, ClaudeUsageFetch } from "../../../bindings";
import { formatUntil } from "../../../lib/format";
import {
  AGENT_ACCOUNT_KEY,
  providerSettingKey,
  useAgentAccounts,
  useClaudeAccountUsage,
  useClaudeGlobalCapture,
  useClaudeRateLimits,
  useCodexAccount,
  useCodexHealth,
  useCodexRateLimits,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { useLiveNow } from "../../../lib/relativeTime";
import { agentBrandColor } from "../../../theme/colors";
import { AgentIcon, CheckIcon, ChevronRightIcon, RefreshIcon } from "../../icons";
import { Dropdown } from "../../primitives";
import { BudgetLine } from "./BudgetLine";
import {
  type ServiceBudget,
  ServiceBudgetRows,
  ServiceMarks,
  useServiceBudgets,
} from "./ServiceBudgets";
import { StatusButton } from "./StatusSegment";
import { claudeWindows, codexWindows, meterColor, type UsageWindow } from "./usageWindows";

type Kind = "Claude" | "Codex";

interface ProviderUsage {
  /** Unique per row: the provider and the account. */
  key: string;
  kind: Kind;
  name: string;
  /** The login's id; `null` is the Default. */
  id: string | null;
  /** Which login the row meters, by its label — `null` while the Default is
   *  the only one shown, so a one-account bar reads exactly as it always has. */
  account: string | null;
  /** Whether a provider has more than one login, i.e. whether there is
   *  anything to pick between. */
  choosable: boolean;
  /** The login new sessions of this provider start on. */
  current: boolean;
  /** Not signed in: nothing could launch on it, so it can't be picked. */
  signedOut: boolean;
  windows: UsageWindow[];
  /** Why there is nothing to show, when the provider itself said. */
  note: string | null;
}

/** At or past this, the chosen login is about to stop a session mid-work. */
const NEARLY_FULL = 90;

const fullest = (windows: UsageWindow[]) => Math.max(0, ...windows.map((w) => w.pct));

/** The row to point at when the provider's current login is nearly spent: the
 *  signed-in one with the most room in its fullest window. Only rows with
 *  numbers — "no data" is not "room". */
function roomiest(rows: ProviderUsage[]): string | undefined {
  const current = rows.find((r) => r.current);
  if (!current || fullest(current.windows) < NEARLY_FULL) return undefined;
  const others = rows.filter(
    (r) => !r.current && !r.signedOut && r.windows.length > 0 && fullest(r.windows) < NEARLY_FULL,
  );
  if (others.length === 0) return undefined;
  return others.reduce((best, r) => (fullest(r.windows) < fullest(best.windows) ? r : best)).key;
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
function barText(w: UsageWindow, nowMs: number): string {
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

/** Why an account's Claude row is empty, when Anthropic said. Only once it has
 *  actually been asked: "not signed in" is a claim, and while the first read is
 *  in flight we don't know it yet. The `detail` is the specific reason (an HTTP
 *  code, a transport error) and never carries anything secret. */
function claudeNote(windows: UsageWindow[], usage: ClaudeUsageFetch | undefined): string | null {
  const status = usage?.status;
  if (windows.length > 0 || !status) return null;
  if (status === "NoCredentials") return "Sign in to Claude Code to see usage";
  if (status === "Unauthorized") return "Claude Code needs signing in again";
  if (status === "Unavailable") return usage?.detail ?? "Anthropic didn't answer";
  return null;
}

/** Every provider's usage, in a fixed order: each provider's Default account —
 *  always both, a provider with nothing to report saying so — then each of
 *  santree's own accounts that has something to show, is signed in, or is the
 *  one new sessions use. */
function useProviderUsage(): {
  providers: ProviderUsage[];
  refresh: () => void;
  fetching: boolean;
  choose: (kind: Kind, id: string | null) => void;
} {
  const chosenClaude =
    useSetting("app", providerSettingKey(AGENT_ACCOUNT_KEY, "Claude")).data ?? "";
  const chosenCodex = useSetting("app", providerSettingKey(AGENT_ACCOUNT_KEY, "Codex")).data ?? "";
  const { mutate: setSetting } = useSetSetting();
  // Anthropic's own answer leads: it needs no session to have run, so it is
  // what fills the meters on a cold start. The stored rows (what the status
  // line captured) stand in while it loads — and are what the command itself
  // returns when there is no credential to ask with.
  const account = useClaudeAccountUsage();
  const stored = useClaudeRateLimits();
  const claudeAccounts = useAgentAccounts("Claude");
  const health = useCodexHealth();
  const codexAccount = useCodexAccount(health.data?.available === true);
  const codexAccounts = useAgentAccounts("Codex", health.data?.available === true);
  const codex = useCodexRateLimits(
    codexAccount.data?.connected === true || !!codexAccounts.data?.some((a) => a.signedIn),
  );

  const providers = useMemo<ProviderUsage[]>(() => {
    const claudeRow = (id: string | null) => {
      // Not `fetched ?? stored`: an account read that failed — rate-limited,
      // signed out, offline — answers with an *empty* list, and `[]` is not
      // nullish, so that spelling silently shadowed the statusline rows and
      // defeated the whole point of having a second source.
      const usage = account.data?.find((a) => a.account === id)?.fetch;
      const fetched = claudeWindows(usage?.windows);
      const windows =
        fetched.length > 0
          ? fetched
          : claudeWindows(stored.data?.find((a) => a.account === id)?.windows);
      return { windows, note: claudeNote(windows, usage) };
    };
    const codexRow = (id: string | null) => ({
      windows: codexWindows(codex.data?.find((a) => a.account === id)?.limits),
      note: null,
    });
    const chosen: Record<Kind, string> = { Claude: chosenClaude, Codex: chosenCodex };
    const rows = (
      kind: Kind,
      accounts: AgentAccount[] | undefined,
      read: (id: string | null) => { windows: UsageWindow[]; note: string | null },
    ): ProviderUsage[] => {
      const extra = (accounts ?? [])
        .map((a) => ({ a, usage: read(a.id) }))
        .filter(({ a, usage }) => a.signedIn || usage.windows.length > 0 || a.id === chosen[kind]);
      const choosable = extra.length > 0;
      // A setting naming an account that is gone launches on the Default.
      const currentId = extra.some(({ a }) => a.id === chosen[kind]) ? chosen[kind] : null;
      return [
        // The Default is named only once there is another login beside it.
        {
          key: `${kind}:`,
          kind,
          name: kind,
          id: null,
          account: choosable ? "Default" : null,
          choosable,
          current: currentId === null,
          signedOut: false,
          ...read(null),
        },
        ...extra.map(({ a, usage }) => ({
          key: `${kind}:${a.id}`,
          kind,
          name: kind,
          id: a.id,
          account: a.label,
          choosable,
          current: a.id === currentId,
          signedOut: !a.signedIn,
          ...usage,
        })),
      ];
    };
    return [
      ...rows("Claude", claudeAccounts.data, claudeRow),
      ...rows("Codex", codexAccounts.data, codexRow),
    ];
  }, [
    account.data,
    stored.data,
    codex.data,
    claudeAccounts.data,
    codexAccounts.data,
    chosenClaude,
    chosenCodex,
  ]);

  return {
    providers,
    refresh: () => {
      void account.refetch();
      void codex.refetch();
    },
    fetching: account.isFetching || codex.isFetching,
    choose: (kind, id) =>
      setSetting({ scope: "app", key: providerSettingKey(AGENT_ACCOUNT_KEY, kind), value: id }),
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
  // The bar shows only the login new sessions use, and names it only when it is
  // not the Default — the one-account bar reads exactly as it always has.
  const account = p.id !== null && p.account && (
    <span className="text-[10.5px] whitespace-nowrap text-muted-4">{p.account}</span>
  );
  if (p.windows.length === 0)
    return account ? (
      <span className="flex items-center gap-1.5">
        <Mark kind={p.kind} />
        {account}
      </span>
    ) : (
      <Mark kind={p.kind} />
    );
  const pct = Math.min(100, Math.max(...p.windows.map((w) => w.pct)));
  return (
    <span className="flex items-center gap-1.5">
      <Mark kind={p.kind} />
      {account}
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
  onChoose,
  mostRoom,
}: {
  p: ProviderUsage;
  nowMs: number;
  onOpen: () => void;
  /** Make this login the one new sessions use. */
  onChoose: () => void;
  /** The current login is nearly spent and this one has the most room left. */
  mostRoom: boolean;
}) {
  const empty = p.windows.length === 0;
  // With one login there is nothing to pick, so the row is the door to the
  // usage history it always was; with several, a click picks.
  const choice = p.choosable
    ? {
        role: "menuitemradio" as const,
        "aria-checked": p.current,
        disabled: p.signedOut,
        title: p.signedOut
          ? "Sign in under Settings → Agents first"
          : p.current
            ? "New sessions start on this account"
            : "Use for new sessions",
        onClick: () => {
          if (!p.current) onChoose();
        },
      }
    : { onClick: onOpen };
  return (
    <button
      type="button"
      {...choice}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover disabled:cursor-default disabled:opacity-60"
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
        {p.account && <span className="flex-none text-[11.5px] text-muted-3">{p.account}</span>}
        {/* Titled as well as shown: a reason can be longer than the column (an
            HTTP code, a transport error), and truncating away the one actionable
            part of an empty row is how this went unexplained. Say why when the
            provider told us; "No usage data" alone leaves the user with nothing
            to do about it. */}
        {empty && (
          <span className="min-w-0 truncate text-[11px] text-muted-4" title={p.note ?? undefined}>
            {p.signedOut ? "Signed out" : (p.note ?? "No usage data")}
          </span>
        )}
        {p.choosable ? (
          <span className="ml-auto flex flex-none items-center gap-1.5 text-[11px] text-muted-3">
            {mostRoom && <span>most room</span>}
            {p.current && (
              <>
                <span>in use</span>
                <CheckIcon size={12} className="text-fg" />
              </>
            )}
          </span>
        ) : (
          <ChevronRightIcon size={12} className="ml-auto flex-none text-muted-4" />
        )}
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
  choose,
  nowMs,
  close,
}: {
  providers: ProviderUsage[];
  services: ServiceBudget[];
  refresh: () => void;
  fetching: boolean;
  choose: (kind: Kind, id: string | null) => void;
  nowMs: number;
  close: () => void;
}) {
  const hints = new Set(
    (["Claude", "Codex"] as const).map((kind) =>
      roomiest(providers.filter((p) => p.kind === kind)),
    ),
  );
  const navigate = useNavigate();
  const capture = useClaudeGlobalCapture();
  // The Default account's row: a session on another login reports through the
  // status line santree layers onto it, so the global capture is only about
  // the Default's sessions started elsewhere.
  const claudeEmpty = providers.some((p) => p.key === "Claude:" && p.windows.length === 0);
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
          <ProviderRow
            key={p.key}
            p={p}
            nowMs={nowMs}
            onOpen={go("usage")}
            onChoose={() => choose(p.kind, p.id)}
            mostRoom={hints.has(p.key)}
          />
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
  const { providers, refresh: refreshProviders, fetching, choose } = useProviderUsage();
  // Only while the panel is open: reading Linear's budget can cost a request
  // (it only reports one in a response), and the bar shows no service numbers
  // to keep fresh.
  const services = useServiceBudgets(open);
  const nowMs = useLiveNow();
  const inUse = providers.filter((p) => p.current);
  const summary = inUse
    .filter((p) => p.windows.length > 0)
    .map(
      (p) =>
        `${p.name}${p.id !== null ? ` (${p.account})` : ""}: ${p.windows
          .map((w) => `${w.pct}% ${w.label}`)
          .join(", ")}`,
    )
    .join(" · ");
  const label = `${summary ? `Usage — ${summary}` : "Usage"} · GitHub and Linear API budgets`;
  const bar: ReactNode = inUse.map((p) => <BarProvider key={p.key} p={p} nowMs={nowMs} />);
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
            choose={choose}
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
