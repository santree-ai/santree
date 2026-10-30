/** The Terminal section's session list: what is open, by project and by what it
 *  belongs to, instead of one flat table of term keys.
 *
 *  A session only knows its `term_key` and cwd. The project comes from the cwd
 *  (the longest registered path that contains it — a ticket id alone is not
 *  unique across projects); the worktree, its tab and the ticket come from the
 *  key and from the same rows the sidebar reads. */

import { type ReactNode, useMemo } from "react";
import type { Repo, TerminalSession, Worktree, WorktreeTab } from "../../../bindings";
import { RepoAvatar } from "../../../components/chrome/RepoAvatar";
import { AgentIcon, BranchIcon, CloseIcon, TerminalIcon } from "../../../components/icons";
import { Dot } from "../../../components/primitives";
import { useWorktrees, useWorktreeTabs } from "../../../lib/queries";
import { palette } from "../../../theme/colors";
import { BASE_TICKET, parseTermKey } from "../../agents/registry";

/** What a session's dot and status word say. Three states, because "running"
 *  and "running but unwatched" are genuinely different things to the user, and
 *  only one of them is a reason to come here. */
export function statusOf(s: TerminalSession): { label: string; color: string; hint: string } {
  if (!s.alive) {
    return {
      label: "Exited",
      color: palette.muted,
      hint: "The process ended. The session is still holding a pty until it is closed.",
    };
  }
  if (!s.attached) {
    return {
      label: "Detached",
      color: palette.amber,
      hint: "Running, with no pane receiving its output. Reopening its worktree attaches to it.",
    };
  }
  return {
    label: "Running",
    color: palette.green,
    hint: "A pane is attached and receiving output.",
  };
}

const ORPHAN_HINT =
  "running, but no tab will ever show them (a tab closed while its server was unreachable, or a worktree deleted under it). Kill them to free the process.";

export { ORPHAN_HINT };

/** A session's one-line name, for the confirm dialog and the kill button. */
export function sessionName(s: TerminalSession): string {
  const o = parseTermKey(s.label);
  if (o.kind === "unknown") return s.cwd?.split("/").slice(-2).join("/") || s.label || "unknown";
  return o.ticket === BASE_TICKET ? "primary checkout" : (o.ticket ?? o.pr ?? s.label);
}

/** The registered project whose checkout contains `cwd` — the deepest one. */
function projectOf(cwd: string | null, repos: Repo[]): Repo | null {
  if (!cwd) return null;
  let best: Repo | null = null;
  for (const r of repos) {
    if (!r.path || (cwd !== r.path && !cwd.startsWith(`${r.path}/`))) continue;
    if (!best || r.path.length > (best.path?.length ?? 0)) best = r;
  }
  return best;
}

interface Surface {
  key: string;
  /** Where it sits in a project, so the primary checkout leads. */
  rank: number;
  kind: "tree" | "triage" | "review" | "other";
  ticket: string | null;
  sessions: TerminalSession[];
}

function surfacesOf(sessions: TerminalSession[]): Surface[] {
  const by = new Map<string, Surface>();
  for (const s of sessions) {
    const o = parseTermKey(s.label);
    let key: string;
    let rank: number;
    let kind: Surface["kind"];
    if (o.kind === "tree" || o.kind === "tree-tab") {
      key = `tree:${o.ticket}`;
      rank = o.ticket === BASE_TICKET ? 0 : 1;
      kind = "tree";
    } else if (o.kind === "triage" || o.kind === "triage-tab") {
      key = `triage:${o.ticket}`;
      rank = 2;
      kind = "triage";
    } else if (o.kind === "review" || o.kind === "ai-review") {
      key = `review:${o.pr}`;
      rank = 3;
      kind = "review";
    } else {
      key = "other";
      rank = 4;
      kind = "other";
    }
    const cur = by.get(key) ?? { key, rank, kind, ticket: o.ticket, sessions: [] };
    cur.sessions.push(s);
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

function Chip({ children, title, tone }: { children: ReactNode; title?: string; tone?: "amber" }) {
  return (
    <span
      title={title}
      className={`flex-none rounded-sm bg-panel px-1.5 py-px text-2xs ${
        tone === "amber" ? "text-status-amber" : "text-muted-3"
      }`}
    >
      {children}
    </span>
  );
}

function SessionRow({
  s,
  label,
  agent,
  orphan,
  oldRevision,
  onKill,
}: {
  s: TerminalSession;
  label: string;
  agent: WorktreeTab["agentKind"];
  orphan: boolean;
  oldRevision: boolean;
  onKill: () => void;
}) {
  const status = statusOf(s);
  return (
    <div
      className="group flex items-center gap-2.5 border-t border-line py-1.5 pr-3 pl-9 text-sm first:border-t-0"
      title={s.cwd ?? s.label}
    >
      <span className="flex size-3.5 flex-none items-center justify-center text-muted-3">
        {agent ? <AgentIcon kind={agent} size={12} /> : <TerminalIcon size={12} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{label}</span>
      {orphan && (
        <Chip tone="amber" title={ORPHAN_HINT}>
          no tab
        </Chip>
      )}
      {oldRevision && (
        <Chip title="Held by an older server revision that is draining.">
          r{s.serverRevision} · draining
        </Chip>
      )}
      <span className="w-[92px] flex-none text-right text-xs text-muted-4 tabular-nums">
        {s.pid ?? "—"} · {s.cols}×{s.rows}
      </span>
      <span
        className="flex w-[78px] flex-none items-center gap-1.5 text-muted-3"
        title={status.hint}
      >
        <Dot color={status.color} />
        {status.label}
      </span>
      <button
        type="button"
        onClick={onKill}
        title={`Kill ${sessionName(s)}`}
        aria-label={`Kill session ${sessionName(s)}`}
        className="flex size-5 flex-none cursor-pointer items-center justify-center rounded text-muted-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-status-red focus-visible:opacity-100"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

function SurfaceBlock({
  surface,
  tabs,
  worktrees,
  orphans,
  currentRevision,
  onKill,
}: {
  surface: Surface;
  tabs: WorktreeTab[];
  worktrees: Worktree[];
  orphans: Set<number>;
  currentRevision: number | null;
  onKill: (s: TerminalSession) => void;
}) {
  const { kind, ticket } = surface;
  const wt = kind === "tree" ? worktrees.find((w) => w.id === ticket) : undefined;
  const isBase = ticket === BASE_TICKET;
  const title =
    kind === "tree"
      ? isBase
        ? "Primary checkout"
        : (wt?.title ?? ticket ?? "Worktree")
      : kind === "triage"
        ? `Triage · ${ticket}`
        : kind === "review"
          ? `Review · ${surface.key.slice("review:".length)}`
          : "Other terminals";
  const sub = kind === "tree" && !isBase ? ticket : null;
  const owner = kind === "triage" ? `triage:${ticket}` : ticket;

  const labelOf = (s: TerminalSession): { label: string; agent: WorktreeTab["agentKind"] } => {
    const o = parseTermKey(s.label);
    if (o.kind === "tree-tab" || o.kind === "triage-tab") {
      const tab = tabs.find((t) => t.id === o.tabId && t.worktreeId === owner);
      return tab
        ? { label: tab.title, agent: tab.agentKind }
        : { label: "Closed tab", agent: null };
    }
    if (o.kind === "tree") return { label: "Main terminal", agent: null };
    if (o.kind === "triage") return { label: "Investigation", agent: null };
    if (o.kind === "ai-review") return { label: "AI review", agent: null };
    if (o.kind === "review") return { label: "Review", agent: null };
    return { label: s.cwd?.split("/").slice(-2).join("/") || s.label, agent: null };
  };

  return (
    <div className="border-t border-line first:border-t-0">
      <div className="flex items-center gap-2 bg-panel/50 py-1.5 pr-3 pl-6 text-sm">
        <BranchIcon size={11} className="flex-none text-muted-4" />
        <span className="min-w-0 truncate font-medium text-fg-2">{title}</span>
        {sub && <span className="flex-none text-xs text-muted-4 tabular-nums">{sub}</span>}
        {wt && !isBase && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-4">{wt.branch}</span>
        )}
        <span className="ml-auto flex-none text-xs text-muted-4">{surface.sessions.length}</span>
      </div>
      {surface.sessions.map((s) => {
        const { label, agent } = labelOf(s);
        return (
          <SessionRow
            key={s.id}
            s={s}
            label={label}
            agent={agent}
            orphan={orphans.has(s.id)}
            oldRevision={
              currentRevision !== null &&
              s.serverRevision != null &&
              s.serverRevision !== currentRevision
            }
            onKill={() => onKill(s)}
          />
        );
      })}
    </div>
  );
}

function ProjectBlock({
  repo,
  sessions,
  orphans,
  currentRevision,
  onKill,
}: {
  repo: Repo | null;
  sessions: TerminalSession[];
  orphans: Set<number>;
  currentRevision: number | null;
  onKill: (s: TerminalSession) => void;
}) {
  // Both hooks take "" for the unmatched group: they are disabled without a repo.
  const { data: tabs = [] } = useWorktreeTabs(repo?.name ?? "");
  const { data: worktrees = [] } = useWorktrees(repo?.name ?? "");
  const surfaces = useMemo(() => surfacesOf(sessions), [sessions]);
  const detached = sessions.filter((s) => s.alive && !s.attached).length;
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        {repo ? (
          <RepoAvatar repo={repo.name} size={15} bordered={false} />
        ) : (
          <TerminalIcon size={13} className="text-muted-4" />
        )}
        <span className="text-base font-semibold text-fg-2">{repo?.name ?? "Elsewhere"}</span>
        {detached > 0 && <Chip tone="amber">{detached} detached</Chip>}
        <span className="ml-auto text-xs text-muted-4">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      {surfaces.map((surface) => (
        <SurfaceBlock
          key={surface.key}
          surface={surface}
          tabs={tabs}
          worktrees={worktrees}
          orphans={orphans}
          currentRevision={currentRevision}
          onKill={onKill}
        />
      ))}
    </div>
  );
}

/** Every session, a card per project. Projects with the most sessions lead. */
export function TerminalSessionList({
  sessions,
  repos,
  orphans,
  currentRevision,
  onKill,
}: {
  sessions: TerminalSession[];
  repos: Repo[];
  orphans: Set<number>;
  currentRevision: number | null;
  onKill: (s: TerminalSession) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<string, { repo: Repo | null; sessions: TerminalSession[] }>();
    for (const s of sessions) {
      const repo = projectOf(s.cwd, repos);
      const key = repo?.name ?? "";
      const cur = by.get(key) ?? { repo, sessions: [] };
      cur.sessions.push(s);
      by.set(key, cur);
    }
    return [...by.values()].sort(
      (a, b) =>
        (a.repo === null ? 1 : 0) - (b.repo === null ? 1 : 0) ||
        b.sessions.length - a.sessions.length ||
        (a.repo?.name ?? "").localeCompare(b.repo?.name ?? ""),
    );
  }, [sessions, repos]);

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {groups.map((g) => (
        <ProjectBlock
          key={g.repo?.name ?? "other"}
          repo={g.repo}
          sessions={g.sessions}
          orphans={orphans}
          currentRevision={currentRevision}
          onKill={onKill}
        />
      ))}
    </div>
  );
}
