/**
 * The service budgets in the Usage cluster — what is left of GitHub's and
 * Linear's API quotas.
 *
 * The agent providers beside them meter *time you can spend*; these meter calls:
 * the pools that every Reviews refresh, PR read and ticket sync draws on. Both
 * services go quiet in the same confusing way when a pool runs out — the inbox
 * empties, the ticket list stops updating, nothing on screen says why — which is
 * the whole reason to be able to look.
 *
 * On the bar they are marks and nothing else. A budget with thousands of
 * headroom is ambient noise, and the bar's width is for what is true *now* about
 * the work; the numbers live one click away in the panel, spelled the way
 * Settings → Integrations spells them (the same pool names from `apiBudgetMeta`,
 * the same thresholds from `apiBudgetColor`) so one reading never reads as two.
 *
 * Looking is not free: Linear reports a budget only in the headers of a call
 * that already spent some of it, so `useServiceBudgets` is gated on the panel
 * actually being open and never polls.
 */
import { useMemo } from "react";

import type { ApiBudgetWindow } from "../../../bindings";
import { useGithubApiBudget, useLinearApiBudget } from "../../../lib/queries";
import { apiBudgetColor, apiBudgetMeta } from "../../../theme/colors";
import { ChevronRightIcon, GitHubLogo, LinearLogo } from "../../icons";
import { BudgetLine } from "./BudgetLine";

type ServiceName = "GitHub" | "Linear";

/** One service's pools, as the panel lists them. */
export interface ServiceBudget {
  /** Stable across renders — a service, or a Linear workspace within it. */
  key: string;
  service: ServiceName;
  /** The workspace these numbers belong to, when more than one is connected.
   *  Linear's limits are per user per OAuth app, so two workspaces really are
   *  two budgets; with one connected the name would just restate the row. */
  workspace: string | null;
  windows: ApiBudgetWindow[];
}

/**
 * Both services' budgets, and nothing for a service that has none.
 *
 * "No data" and "no headroom" are different claims: GitHub answers `null` when
 * `gh` isn't signed in and Linear answers an empty list when no workspace is
 * connected, and a row of zeroes for either would read as "you're out". So a
 * service with nothing to report is absent rather than empty.
 *
 * `enabled` must be the panel's open state. Reading Linear's budget can cost a
 * request, and nobody is owed one for a panel that is shut.
 */
export function useServiceBudgets(enabled: boolean): {
  services: ServiceBudget[];
  refresh: () => void;
  fetching: boolean;
} {
  const github = useGithubApiBudget(enabled);
  const linear = useLinearApiBudget(enabled);

  const services = useMemo<ServiceBudget[]>(() => {
    const out: ServiceBudget[] = [];
    const githubWindows = github.data?.windows ?? [];
    if (githubWindows.length > 0) {
      out.push({ key: "github", service: "GitHub", workspace: null, windows: githubWindows });
    }
    const orgs = linear.data ?? [];
    for (const org of orgs) {
      if (org.windows.length === 0) continue;
      out.push({
        key: `linear:${org.slug}`,
        service: "Linear",
        workspace: orgs.length > 1 ? org.name : null,
        windows: org.windows,
      });
    }
    return out;
  }, [github.data, linear.data]);

  return {
    services,
    refresh: () => {
      void github.refetch();
      void linear.refetch();
    },
    fetching: github.isFetching || linear.isFetching,
  };
}

/** Optical sizing, same problem the provider marks have: both of these are solid
 *  shapes that fill their whole viewBox — like Codex's knot rather than Claude's
 *  thin star — so they take the same reduction Codex's does, or they sit a size
 *  larger than everything beside them. */
const GLYPH_SCALE = 0.86;

/** One service's logomark. Linear wears its brand purple wherever it identifies
 *  the service; GitHub's mark is monochrome by design, so it inherits whatever
 *  tone it is sitting in (muted on the bar, brighter on hover). */
export function ServiceMark({ service, size = 11 }: { service: ServiceName; size?: number }) {
  const px = Math.round(size * GLYPH_SCALE);
  return service === "Linear" ? (
    <LinearLogo size={px} className="flex-none text-[color:var(--linear-brand)]" />
  ) : (
    <GitHubLogo size={px} className="flex-none" />
  );
}

/** The services on the collapsed bar: two marks, no numbers.
 *
 *  Unconditional, like the provider marks beside them — the mark is the door to
 *  the panel, not a claim that either service answered. Which of them did is
 *  behind the click, and can't be known before it: asking Linear costs a
 *  request, which is exactly what the gate exists to avoid spending here. */
export function ServiceMarks() {
  return (
    <>
      <ServiceMark service="GitHub" />
      <ServiceMark service="Linear" />
    </>
  );
}

/** One pool's numbers: what is left, what it is out of, and how full it reads.
 *
 *  `?? 0` because specta cannot export a 64-bit integer, so every count crosses
 *  the bridge as `number | null` even though the backend always sends one. */
function poolFill(w: ApiBudgetWindow) {
  const limit = w.limit ?? 0;
  const remaining = Math.max(0, w.remaining ?? 0);
  // Filled with what has been *spent*, matching the settings meters: a gauge
  // that empties as you work makes the almost-full bar the notable state.
  // A zero limit is a service that answered with nonsense — show the pool, but
  // never divide by it.
  const pct = limit > 0 ? Math.min(100, ((limit - remaining) / limit) * 100) : 0;
  return { limit, remaining, pct, color: apiBudgetColor(remaining, limit) };
}

/** One pool, on the panel's shared metered line: name, meter, what's left of it,
 *  and when it refills. */
function PoolLine({ window: w, nowMs }: { window: ApiBudgetWindow; nowMs: number }) {
  const meta = apiBudgetMeta[w.kind];
  const { limit, remaining, pct, color } = poolFill(w);
  return (
    <BudgetLine
      label={meta.label}
      hint={meta.hint}
      pct={pct}
      color={color}
      // Exact, not compacted: "4.9k of 5k" and "4,982 of 5,000" answer different
      // questions, and the one worth asking here is how much is actually left.
      value={
        <>
          {Math.round(remaining).toLocaleString()}
          <span className="text-muted-4"> / {Math.round(limit).toLocaleString()}</span>
        </>
      }
      resetsAtMs={w.resetsAtMs}
      nowMs={nowMs}
    />
  );
}

/** One service's row: the mark and name, then a line per pool. The same shape as
 *  the provider rows above it — same tile, same name line, same click into
 *  settings, and literally the same `BudgetLine` beneath, so a column of budgets
 *  lines up whether it is counting calls or hours. */
function ServiceRow({
  budget,
  nowMs,
  onOpen,
}: {
  budget: ServiceBudget;
  nowMs: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-hover"
    >
      <span className="flex items-center gap-2.5">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-raised-2 text-fg-2">
          <ServiceMark service={budget.service} size={13} />
        </span>
        <span className="text-[12.5px] font-semibold text-fg">{budget.service}</span>
        {budget.workspace && (
          <span className="min-w-0 truncate text-[11px] text-muted-4">{budget.workspace}</span>
        )}
        <ChevronRightIcon size={12} className="ml-auto flex-none text-muted-4" />
      </span>
      <span className="flex flex-col gap-1">
        {budget.windows.map((w) => (
          <PoolLine key={w.kind} window={w} nowMs={nowMs} />
        ))}
      </span>
    </button>
  );
}

/** The panel's service block, or nothing at all when neither service answered. */
export function ServiceBudgetRows({
  services,
  nowMs,
  onOpen,
}: {
  services: ServiceBudget[];
  nowMs: number;
  onOpen: () => void;
}) {
  if (services.length === 0) return null;
  return (
    <div className="flex flex-col border-t border-line px-1 py-1">
      {services.map((budget) => (
        <ServiceRow key={budget.key} budget={budget} nowMs={nowMs} onOpen={onOpen} />
      ))}
    </div>
  );
}
