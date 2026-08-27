/** Settings → Usage: Claude Code token consumption across all local sessions.
 *
 * Reads the aggregated report the backend derives from `~/.claude/projects`
 * transcripts (see `usage.rs`) and shows period/model totals plus each recent
 * session's context-window fill — "how much before compaction". Live: the usage
 * watcher invalidates the query as sessions grow. */

import { type ReactNode, useMemo, useState } from "react";

import type {
  AgentKind,
  CodexRateLimitWindow,
  ModelUsage,
  SessionUsage,
  UsageTotals,
} from "../../../bindings";
import { AgentIcon, ChevronRightIcon } from "../../../components/icons";
import { EmptyState, Tabs, TerminalActivity } from "../../../components/primitives";
import { formatCompact, formatUsd } from "../../../lib/format";
import {
  useClaudeUsage,
  useCodexAccount,
  useCodexHealth,
  useCodexRateLimits,
  useUsageProgress,
} from "../../../lib/queries";
import { formatRelativeTime, useLiveNow } from "../../../lib/relativeTime";
import { splitRepoPath } from "../../../lib/repo";
import { modelMeta, modelVersion } from "../../../theme/colors";
import { Heading } from "../widgets";

/** Total tokens that flowed for a bucket — every class, nulls as 0. Used only to
 *  decide whether a bucket is truly empty. */
function sumTokens(t: UsageTotals): number {
  return (
    (t.inputTokens ?? 0) +
    (t.outputTokens ?? 0) +
    (t.cacheReadTokens ?? 0) +
    (t.cacheWriteTokens ?? 0)
  );
}

/** The headline "tokens" figure: input + output + cache **writes**. Deliberately
 *  EXCLUDES cache reads — the same context re-read every turn, which is 98%+ of the
 *  raw total on long sessions and reads as wildly inflated "consumption". Cache
 *  reads are cheap re-reads, not new work; they're surfaced on their own in the
 *  session hover instead. */
function workTokens(t: UsageTotals): number {
  return (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheWriteTokens ?? 0);
}

export function UsageSection() {
  const [agent, setAgent] = useState<AgentKind>("Claude");

  return (
    <>
      <Heading title="Usage" subtitle="Token activity and limits reported by each agent." />
      <Tabs
        tabs={[
          {
            value: "Claude" as const,
            label: "Claude Code",
            icon: <AgentIcon kind="Claude" size={13} />,
          },
          {
            value: "Codex" as const,
            label: "Codex",
            icon: <AgentIcon kind="Codex" size={13} />,
          },
        ]}
        value={agent}
        onChange={setAgent}
        className="mb-4"
      />
      {agent === "Claude" ? <ClaudeUsagePanel /> : <CodexUsagePanel />}
    </>
  );
}

function ClaudeUsagePanel() {
  const { data, isLoading, isError } = useClaudeUsage();
  const progress = useUsageProgress();

  if (isLoading) {
    return <UsageLoading progress={progress} />;
  }

  const empty = isError || !data || sumTokens(data.total) === 0;
  return (
    <div>
      {empty ? (
        <EmptyState
          className="py-10"
          title={isError ? "Couldn't read usage." : "No Claude usage yet."}
          subtitle={
            isError
              ? "Check santree.log for details."
              : "Once you've run Claude, your token usage shows up here."
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <PeriodCards data={data} />
          <ByModelCard models={data.byModel} />
          <SessionsCard sessions={data.sessions} />
          <p className="px-1 text-[11px] leading-[1.5] text-muted-4">
            Token counts are exact, read from Claude's local session transcripts. Costs are
            estimated from published API prices (refreshed daily) and are approximate.
          </p>
        </div>
      )}
    </div>
  );
}

function formatCodexWindow(window: CodexRateLimitWindow | null): string {
  if (!window) return "Unavailable";
  const used = `${Math.round(window.usedPercent ?? 0)}% used`;
  const duration = window.windowMinutes ? `${window.windowMinutes} min window` : null;
  const resetMs = window.resetsAt
    ? window.resetsAt < 10_000_000_000
      ? window.resetsAt * 1_000
      : window.resetsAt
    : null;
  const reset = resetMs
    ? `resets ${new Date(resetMs).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })}`
    : null;
  return [used, duration, reset].filter(Boolean).join(" · ");
}

function CodexUsagePanel() {
  const health = useCodexHealth();
  const account = useCodexAccount(health.data?.available === true);
  const limits = useCodexRateLimits(account.data?.connected === true);

  if (health.isLoading || account.isLoading || limits.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <TerminalActivity label="Reading usage…" />
      </div>
    );
  }
  if (!health.data?.available) {
    return (
      <EmptyState
        className="py-10"
        title="Codex isn't available."
        subtitle={
          health.data?.error || "Install Codex or set its executable path in Settings → Agents."
        }
      />
    );
  }
  if (!account.data?.connected) {
    return (
      <EmptyState
        className="py-10"
        title="Codex isn't connected."
        subtitle={
          account.error?.message ||
          "Connect Codex in Settings → Agents → Codex to see its current usage limits."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Account">
        <div className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-[12px]">
          <span className="text-muted-3">Account</span>
          <span className="text-fg-2">{account.data.email || "Managed by Codex CLI"}</span>
          <span className="text-muted-3">Plan</span>
          <span className="text-fg-2">
            {limits.data?.plan || account.data.plan || "Unavailable"}
          </span>
        </div>
      </Card>
      <Card title="Rate limits">
        <div className="flex flex-col gap-2 text-[12px]">
          <div className="grid grid-cols-[7rem_1fr] gap-x-4">
            <span className="text-muted-3">Primary</span>
            <span className="text-fg-2">{formatCodexWindow(limits.data?.primary ?? null)}</span>
          </div>
          <div className="grid grid-cols-[7rem_1fr] gap-x-4">
            <span className="text-muted-3">Secondary</span>
            <span className="text-fg-2">{formatCodexWindow(limits.data?.secondary ?? null)}</span>
          </div>
        </div>
      </Card>
      <p className="px-1 text-[11px] leading-[1.5] text-muted-4">
        Codex reports current rate-limit windows and live thread token usage. Santree does not
        currently receive a durable billing history, so it does not estimate historical cost.
      </p>
    </div>
  );
}

/** The first-load state. Shows a determinate progress bar once the backend starts
 *  reporting file-count progress (a cold parse of many transcripts takes a moment);
 *  falls back to a spinner until the first progress event lands, or on a warm load. */
function UsageLoading({ progress }: { progress: { done: number; total: number } | null }) {
  if (!progress || progress.total === 0) {
    return (
      <div className="flex justify-center py-12">
        <TerminalActivity label="Reading transcripts…" />
      </div>
    );
  }
  const pct = Math.min(100, (progress.done / progress.total) * 100);
  return (
    <div className="flex flex-col items-center gap-2.5 py-12">
      <div className="text-[12.5px] text-muted-2">Reading transcripts…</div>
      <div className="h-1.5 w-56 overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${pct}%`, background: "var(--accent)" }}
        />
      </div>
      <div className="text-[11px] tabular-nums text-muted-4">
        {progress.done} / {progress.total}
      </div>
    </div>
  );
}

/** A card shell matching the other Settings sections. */
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line-2 bg-raised px-4 py-3.5">
      <div className="mb-3 text-[12px] font-medium text-muted-2">{title}</div>
      {children}
    </div>
  );
}

/** Today / this week / this month totals, as three stat tiles. */
function PeriodCards({
  data,
}: {
  data: { today: UsageTotals; week: UsageTotals; month: UsageTotals };
}) {
  const tiles: [string, UsageTotals][] = [
    ["Today", data.today],
    ["This week", data.week],
    ["This month", data.month],
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map(([label, t]) => (
        <div key={label} className="rounded-xl border border-line-2 bg-raised px-4 py-3.5">
          <div className="text-[11.5px] text-muted-3">{label}</div>
          <div className="mt-1 text-[22px] font-semibold leading-none text-fg-bright tabular-nums">
            {formatCompact(workTokens(t))}
          </div>
          <div className="mt-1.5 text-[11.5px] text-muted-3">
            <span className="text-fg-3">{formatUsd(t.costUsd)}</span> · tokens
          </div>
        </div>
      ))}
    </div>
  );
}

/** One model version within a family group. */
type Version = { model: string; tokens: number; cost: number };
/** A family (Opus/Sonnet/…) with its versions folded together. */
type Family = {
  key: string;
  label: string;
  color: string;
  tokens: number;
  cost: number;
  versions: Version[];
};

/** Fold per-version model rows into one group per family, each sorted by usage. */
function groupByFamily(models: ModelUsage[]): Family[] {
  const map = new Map<string, Family>();
  for (const m of models) {
    const { key, label, color } = modelMeta(m.model);
    const tokens = workTokens(m.totals);
    const cost = m.totals.costUsd ?? 0;
    const g = map.get(key) ?? { key, label, color, tokens: 0, cost: 0, versions: [] };
    g.tokens += tokens;
    g.cost += cost;
    g.versions.push({ model: m.model, tokens, cost });
    map.set(key, g);
  }
  const groups = [...map.values()];
  for (const g of groups) g.versions.sort((a, b) => b.tokens - a.tokens);
  return groups.sort((a, b) => b.tokens - a.tokens);
}

/** Distinguish versions within a family: lighten each successive segment. The
 *  step is large so even two versions read as clearly different shades. */
function shade(color: string, i: number): string {
  if (i === 0) return color;
  const toward = Math.min(66, i * 34);
  return `color-mix(in srgb, ${color} ${100 - toward}%, white)`;
}

/** One family's bar: a segmented fill plus a hover tooltip listing every version.
 *  The tooltip is on the whole bar (not the segments) so a tiny version segment
 *  is still discoverable — a 2px sliver is impossible to hover directly. */
function ModelBar({ f, max }: { f: Family; max: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-16 flex-none text-[12px] font-medium text-fg-3">{f.label}</div>
      <div className="group relative flex-1">
        <div className="h-2.5 overflow-hidden rounded-full bg-surface">
          <div
            className="flex h-full overflow-hidden rounded-full"
            style={{ width: `${Math.max(2, (f.tokens / max) * 100)}%` }}
          >
            {f.versions.map((v, i) => (
              <div
                key={v.model}
                className="h-full"
                style={{
                  width: `${Math.max(2, (v.tokens / f.tokens) * 100)}%`,
                  background: shade(f.color, i),
                  // A hairline divider between adjacent versions (layout-neutral).
                  boxShadow: i > 0 ? "inset 1px 0 0 rgba(0,0,0,0.45)" : undefined,
                }}
              />
            ))}
          </div>
        </div>
        {/* Hover tooltip over the whole bar — lists each version with its swatch. */}
        <div className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden min-w-max rounded-lg border border-line-2 bg-raised px-2.5 py-1.5 shadow-lg group-hover:block">
          <div className="flex flex-col gap-1">
            {f.versions.map((v, i) => (
              <div key={v.model} className="flex items-center gap-2 text-[11px]">
                <span
                  className="h-2 w-2 flex-none rounded-full"
                  style={{ background: shade(f.color, i) }}
                />
                <span className="text-fg-2">{modelVersion(v.model)}</span>
                <span className="ml-auto pl-3 tabular-nums text-muted-3">
                  {formatCompact(v.tokens)} · {formatUsd(v.cost)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="w-28 flex-none text-right text-[11.5px] tabular-nums text-muted-2">
        {formatCompact(f.tokens)}
        <span className="text-muted-4"> · {formatUsd(f.cost)}</span>
      </div>
    </div>
  );
}

/** Per-family horizontal bars, widest (most tokens) first. Each bar is split into
 *  one segment per model version; hover the bar for the version breakdown. */
function ByModelCard({ models }: { models: ModelUsage[] }) {
  if (models.length === 0) return null;
  const families = groupByFamily(models);
  const max = Math.max(...families.map((f) => f.tokens), 1);
  return (
    <Card title="By model">
      <div className="flex flex-col gap-2.5">
        {families.map((f) => (
          <ModelBar key={f.key} f={f} max={max} />
        ))}
      </div>
    </Card>
  );
}

/** All sessions that ran in one location — the `main` checkout, or a single
 *  worktree (i.e. all the runs spent working on one issue). */
type LocationGroup = {
  location: string;
  isMain: boolean;
  sessions: SessionUsage[];
  tokens: number;
  cost: number;
  lastMs: number;
};

/** One repo's sessions, folded together and sorted by recency. */
type RepoGroup = {
  repo: string;
  label: string;
  locations: LocationGroup[];
  sessions: SessionUsage[];
  tokens: number;
  cost: number;
  lastMs: number;
};

/** A folder (repo owner, e.g. `canary-technologies-corp`) with all its repos folded
 *  together — the outer grouping level above repos. */
type FolderGroup = {
  folder: string;
  repos: RepoGroup[];
  sessionCount: number;
  tokens: number;
  cost: number;
  lastMs: number;
};

/** A stable identity for a session (repo + id) — the current-session key. */
const sessionKey = (s: SessionUsage) => `${s.repo} ${s.sessionId}`;

/** Generic recency-preserving group-by: bucket items by key in first-seen order.
 *  Sessions arrive newest-first, so a bucket's first appearance is its latest. */
function bucket<T>(items: T[], keyOf: (item: T) => string): [string, T[]][] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else {
      map.set(key, [item]);
      order.push(key);
    }
  }
  return order.map((key) => [key, map.get(key) ?? []]);
}

const sumTokensOf = (sessions: SessionUsage[]) =>
  sessions.reduce((a, s) => a + workTokens(s.totals), 0);
const sumCostOf = (sessions: SessionUsage[]) =>
  sessions.reduce((a, s) => a + (s.totals.costUsd ?? 0), 0);
const lastMsOf = (sessions: SessionUsage[]) =>
  Math.max(...sessions.map((s) => s.lastActivityMs ?? 0));

/** Group a repo's sessions by location: one "main" bucket for the checkout plus one
 *  per worktree (all the runs spent on that issue), newest activity first. */
function groupByLocation(sessions: SessionUsage[]): LocationGroup[] {
  return bucket(sessions, (s) => s.worktree ?? "main").map(([location, list]) => ({
    location,
    isMain: !list[0].worktree,
    sessions: list,
    tokens: sumTokensOf(list),
    cost: sumCostOf(list),
    lastMs: lastMsOf(list),
  }));
}

/** Group sessions by repo, then by location within each repo. Recency-ordered. */
function groupByRepo(sessions: SessionUsage[]): RepoGroup[] {
  return bucket(sessions, (s) => s.repo).map(([repo, list]) => ({
    repo,
    label: splitRepoPath(repo).label,
    locations: groupByLocation(list),
    sessions: list,
    tokens: sumTokensOf(list),
    cost: sumCostOf(list),
    lastMs: lastMsOf(list),
  }));
}

/** Fold repo groups into their owning folders, preserving recency order (repos
 *  already arrive newest-first, so a folder's first appearance is its latest). */
function groupByFolder(repos: RepoGroup[]): FolderGroup[] {
  return bucket(repos, (r) => splitRepoPath(r.repo).folder).map(([folder, list]) => ({
    folder,
    repos: list,
    sessionCount: list.reduce((a, r) => a + r.sessions.length, 0),
    tokens: list.reduce((a, r) => a + r.tokens, 0),
    cost: list.reduce((a, r) => a + r.cost, 0),
    lastMs: Math.max(...list.map((r) => r.lastMs)),
  }));
}

/** The right-aligned summary shown on a folder/repo header: count · tokens · cost · when. */
function GroupSummary({
  count,
  tokens,
  cost,
  lastMs,
  now,
}: {
  count: number;
  tokens: number;
  cost: number;
  lastMs: number;
  now: number;
}) {
  return (
    <>
      <span className="flex-none rounded bg-surface px-1.5 py-px text-[10px] tabular-nums text-muted-3">
        {count}
      </span>
      <span className="ml-auto flex-none pl-3 text-[11px] tabular-nums text-muted-3">
        {formatCompact(tokens)} · {formatUsd(cost)}
        {lastMs > 0 && ` · ${formatRelativeTime(lastMs, now)}`}
      </span>
    </>
  );
}

/** A collapsible header row (folder or repo). */
function GroupHeader({
  open,
  onToggle,
  label,
  strong,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 py-2 text-left"
    >
      <span className={`flex-none text-muted-3 transition-transform ${open ? "rotate-90" : ""}`}>
        <ChevronRightIcon size={11} />
      </span>
      <span
        className={`truncate ${strong ? "text-[12.5px] font-medium text-fg-2" : "text-[12px] text-fg-3"}`}
      >
        {label}
      </span>
      {children}
    </button>
  );
}

/** A unique key for a location within a repo (worktree ids can repeat across repos). */
const locationKey = (repo: string, location: string) => `${repo}\n${location}`;

/** Recent sessions grouped into a collapsible folder → repo → location tree, where a
 *  location is the `main` checkout or a single worktree (all the runs on one issue).
 *  Everything starts collapsed. */
function SessionsCard({ sessions }: { sessions: SessionUsage[] }) {
  const now = useLiveNow();
  // Everything collapsed by default; toggling flips membership. Each level keys
  // independently: repo keys are the full `owner/repo`, location keys prefix the repo.
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const [openRepos, setOpenRepos] = useState<Set<string>>(() => new Set());
  const [openLocations, setOpenLocations] = useState<Set<string>>(() => new Set());
  // The three-level group/sum/fold is O(sessions) and only depends on the data —
  // without this it re-runs on every `useLiveNow` tick (and every expand/collapse).
  const folders = useMemo(() => groupByFolder(groupByRepo(sessions)), [sessions]);
  if (sessions.length === 0) return null;

  const currentKey = sessionKey(sessions[0]);
  const toggle = (setter: typeof setOpenFolders, key: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card title="Recent sessions">
      <div className="flex flex-col">
        {folders.map((f) => {
          const folderOpen = openFolders.has(f.folder);
          return (
            <div key={f.folder} className="border-t border-line first:border-t-0">
              <GroupHeader
                open={folderOpen}
                onToggle={() => toggle(setOpenFolders, f.folder)}
                label={f.folder}
                strong
              >
                <GroupSummary
                  count={f.sessionCount}
                  tokens={f.tokens}
                  cost={f.cost}
                  lastMs={f.lastMs}
                  now={now}
                />
              </GroupHeader>
              {folderOpen && (
                <div className="flex flex-col pl-[22px]">
                  {f.repos.map((r) => {
                    const repoOpen = openRepos.has(r.repo);
                    return (
                      <div key={r.repo} className="border-t border-line">
                        <GroupHeader
                          open={repoOpen}
                          onToggle={() => toggle(setOpenRepos, r.repo)}
                          label={r.label}
                        >
                          <GroupSummary
                            count={r.sessions.length}
                            tokens={r.tokens}
                            cost={r.cost}
                            lastMs={r.lastMs}
                            now={now}
                          />
                        </GroupHeader>
                        {repoOpen && (
                          <div className="flex flex-col pl-[22px]">
                            {r.locations.map((loc) => {
                              const key = locationKey(r.repo, loc.location);
                              const locOpen = openLocations.has(key);
                              return (
                                <div key={key} className="border-t border-line">
                                  <GroupHeader
                                    open={locOpen}
                                    onToggle={() => toggle(setOpenLocations, key)}
                                    label={loc.isMain ? "main" : loc.location}
                                  >
                                    <GroupSummary
                                      count={loc.sessions.length}
                                      tokens={loc.tokens}
                                      cost={loc.cost}
                                      lastMs={loc.lastMs}
                                      now={now}
                                    />
                                  </GroupHeader>
                                  {locOpen && (
                                    <div className="flex flex-col pb-1 pl-[22px]">
                                      {loc.sessions.map((s) => (
                                        <SessionRow
                                          key={sessionKey(s)}
                                          s={s}
                                          now={now}
                                          current={sessionKey(s) === currentKey}
                                        />
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** One session row inside a location group. Its location is the group header, so the
 *  row is labelled by when it last ran (falling back to its model) to tell the runs of
 *  one issue apart — then its context-fill meter, tokens and cost. */
function SessionRow({ s, now, current }: { s: SessionUsage; now: number; current: boolean }) {
  const activity = s.lastActivityMs ?? 0;
  const label = activity > 0 ? formatRelativeTime(activity, now) : modelVersion(s.model);
  return (
    <div className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] text-fg-3">{label}</span>
          {current && (
            <span className="flex-none rounded bg-surface px-1 py-px text-[9.5px] uppercase tracking-wide text-muted-3">
              current
            </span>
          )}
        </div>
        <SessionMeter s={s} />
      </div>
      {/* Total spent this session (all turns, cumulative — unaffected by compaction),
          with its cost. Distinct from the context-fill bar, which is live headroom. */}
      <div className="w-28 flex-none text-right tabular-nums">
        <div className="text-[11.5px] text-fg-3">{formatCompact(workTokens(s.totals))}</div>
        <div className="text-[10.5px] text-muted-4">{formatUsd(s.totals.costUsd)}</div>
      </div>
    </div>
  );
}

/** The session's context-window fill bar, colored by the model(s) it used — the
 *  same family colors as the "By model" chart, so a glance shows the model without
 *  hovering. Bar length = context fill (the "before compaction" signal); segment
 *  widths = each model's token share. Hover for the exact per-model breakdown,
 *  including the versions and any mid-session model switches. */
function SessionMeter({ s }: { s: SessionUsage }) {
  const models = s.models.length > 0 ? s.models : [{ model: s.model, totals: s.totals }];
  // Segment widths track real work (input+output+cache-write), matching the
  // headline figures — cache reads are shown separately in the breakdown below.
  const total = models.reduce((a, m) => a + workTokens(m.totals), 0) || 1;
  const limit = s.contextLimit ?? 200_000;
  const fill = Math.min(100, limit > 0 ? ((s.contextTokens ?? 0) / limit) * 100 : 0);
  // The four token classes for this session — cache read last (it's excluded
  // from the headline, so it's labelled as re-reads that don't count).
  const classes: [string, number, boolean][] = [
    ["Input", s.totals.inputTokens ?? 0, false],
    ["Output", s.totals.outputTokens ?? 0, false],
    ["Cache write", s.totals.cacheWriteTokens ?? 0, false],
    ["Cache read", s.totals.cacheReadTokens ?? 0, true],
  ];
  return (
    <div className="group relative mt-1 flex items-center gap-2">
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface">
        <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${fill}%` }}>
          {models.map((m) => (
            <div
              key={m.model}
              className="h-full"
              style={{
                width: `${(workTokens(m.totals) / total) * 100}%`,
                background: modelMeta(m.model).color,
              }}
            />
          ))}
        </div>
      </div>
      <span className="flex-none text-[10px] tabular-nums text-muted-4">
        {formatCompact(s.contextTokens ?? 0)} / {formatCompact(limit)}
      </span>
      <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden min-w-max rounded-lg border border-line-2 bg-raised px-2.5 py-1.5 shadow-lg group-hover:block">
        <div className="flex flex-col gap-1">
          <div className="mb-0.5 flex items-center gap-3 border-b border-line pb-1 text-[10px] text-muted-4">
            <span className="uppercase tracking-wide">Session</span>
            <span className="ml-auto font-mono text-muted-3">{s.sessionId}</span>
          </div>
          {models.map((m) => (
            <div key={m.model} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: modelMeta(m.model).color }}
              />
              <span className="text-fg-2">{modelVersion(m.model)}</span>
              <span className="ml-auto pl-3 tabular-nums text-muted-3">
                {formatCompact(workTokens(m.totals))} · {formatUsd(m.totals.costUsd)}
              </span>
            </div>
          ))}
          {/* Per-class breakdown — makes the (excluded) cache-read re-reads visible,
              so the headline "real work" figure is explainable at a glance. */}
          <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1.5">
            {classes.map(([label, value, isRead]) => (
              <div
                key={label}
                className={`flex items-center gap-3 text-[10.5px] ${
                  isRead ? "text-muted-4" : "text-muted-3"
                }`}
              >
                <span>{label}</span>
                {isRead && <span className="text-muted-4">· re-reads, not counted</span>}
                <span className="ml-auto tabular-nums">{formatCompact(value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
