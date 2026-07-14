/**
 * The Terminal tab: a sidebar of open sessions grouped **project → ticket**
 * (plus a flat Shells section), a session tab strip above the content area, and
 * a launcher. A ticket is one sidebar item no matter how many terminals it has
 * open — its work terminal, extra Claude/terminal tabs, and triage
 * investigation all appear as tabs in the strip. The terminals themselves
 * render in the persistent `TerminalLayer` (mounted at the app shell) so they
 * survive navigation; the layer overlays the area below the strip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentKind } from "../../bindings";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { AgentIcon, ClaudeSparkIcon, CliIcon, TerminalIcon } from "../../components/icons";
import { onTabStripKeyDown, ProjectGlyph, underlineTabStyle } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import {
  useBaseWorktree,
  useRepos,
  useTasks,
  useWorktrees,
  useWorktreeTabs,
} from "../../lib/queries";
import { CHROME, useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import {
  BASE_TICKET,
  groupByProject,
  groupSessions,
  parseSessionRef,
  type SessionKind,
  sessionMeta,
  type TicketGroup,
} from "./grouping";
import type { TerminalTab } from "./orchestrator";
import { useTerminals } from "./TerminalsContext";

/** The sidebar item a session belongs to: its ticket, or itself for a shell. */
function itemOf(tab: TerminalTab): string {
  const ref = parseSessionRef(tab);
  return ref.ticket ? `ticket:${ref.ticket}` : `shell:${tab.key}`;
}

export function TerminalSurface() {
  const { activeRepo } = useApp();
  const { data: repos } = useRepos();
  const repoPath = repos?.find((r) => r.name === activeRepo)?.path ?? undefined;
  const { tabs, activeKey, setActiveKey, open, close } = useTerminals();
  const { data: worktrees = [] } = useWorktrees(activeRepo);
  const { data: baseWorktree = null } = useBaseWorktree(activeRepo);
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: extraRowList = [] } = useWorktreeTabs(activeRepo);
  const [cmd, setCmd] = useState("");
  const started = useRef(false);

  // Open one shell the first time the tab is visited with no sessions yet — but
  // only once the cwd is actually known. Spawning is not idempotent, so the latch
  // is one-way: starting while `repos` is still loading would open (and keep) the
  // shell in the wrong directory forever. With no repos at all there is no cwd to
  // wait for, so a plain shell is correct.
  useEffect(() => {
    if (started.current || tabs.length > 0) return;
    if (!repos || (repos.length > 0 && !repoPath)) return;
    started.current = true;
    open({ title: "shell", cwd: repoPath });
  }, [open, repos, repoPath, tabs.length]);

  const extraRows = useMemo(() => new Map(extraRowList.map((r) => [r.id, r])), [extraRowList]);
  const worktreeById = useMemo(() => new Map(worktrees.map((w) => [w.id, w])), [worktrees]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  // Project glyph color/icon, from whichever task carries them.
  const projectMeta = useMemo(() => {
    const map = new Map<string, { color: string | null; icon: string | null }>();
    for (const t of tasks) {
      if (t.project && !map.has(t.project)) {
        map.set(t.project, { color: t.projectColor, icon: t.projectIcon });
      }
    }
    return map;
  }, [tasks]);

  const { shells, tickets } = useMemo(() => groupSessions(tabs), [tabs]);
  // A ticket's project comes from its worktree, else its Linear task (covers
  // triage-only sessions); unknown tickets land in the "No project" section.
  const projectOf = useCallback(
    (id: string) => worktreeById.get(id)?.project ?? taskById.get(id)?.project ?? null,
    [worktreeById, taskById],
  );
  const sections = useMemo(() => groupByProject(tickets, projectOf), [tickets, projectOf]);

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null;
  const selectedItem = activeTab ? itemOf(activeTab) : null;
  // The strip shows the selected item's sessions (a shell item has exactly one).
  const stripTabs = useMemo(
    () => (selectedItem ? tabs.filter((t) => itemOf(t) === selectedItem) : []),
    [tabs, selectedItem],
  );
  // Keep the strip's tab order consistent with the sidebar grouping.
  const orderedStripTabs = useMemo(() => {
    const group = tickets.find((g) => `ticket:${g.ticket}` === selectedItem);
    return group ? group.tabs : stripTabs;
  }, [tickets, selectedItem, stripTabs]);

  // Remember each item's last-shown session, so clicking a ticket back in the
  // sidebar restores the tab you were on instead of snapping to the first.
  const lastByItem = useRef<Record<string, string>>({});
  useEffect(() => {
    if (activeTab) lastByItem.current[itemOf(activeTab)] = activeTab.key;
  }, [activeTab]);

  const selectTicket = (group: TicketGroup) => {
    const remembered = lastByItem.current[`ticket:${group.ticket}`];
    const target = group.tabs.find((t) => t.key === remembered) ?? group.tabs[0];
    if (target) setActiveKey(target.key);
  };

  /** Ticket display bits: the base entry shows its branch, others id + title. */
  const ticketLabel = (ticket: string): { id: string; title: string | null } => {
    if (ticket === BASE_TICKET) {
      return { id: baseWorktree?.branch || "base", title: baseWorktree?.title ?? null };
    }
    return {
      id: ticket,
      title: worktreeById.get(ticket)?.title ?? taskById.get(ticket)?.title ?? null,
    };
  };

  /** The strip icon for one session (see {@link SessionKind}). */
  const kindIcon = (tab: TerminalTab, kind: SessionKind) => {
    if (kind === "investigation" || kind === "claude") return <ClaudeSparkIcon />;
    if (kind === "work") {
      const ticket = parseSessionRef(tab).ticket;
      if (ticket === BASE_TICKET) return <TerminalIcon size={11} className="text-muted-3" />;
      const agent: AgentKind = worktreeById.get(ticket ?? "")?.agent ?? "Claude";
      return agent === "Claude" ? (
        <ClaudeSparkIcon />
      ) : (
        <AgentIcon kind={agent} size={11} className="text-muted-3" />
      );
    }
    return <TerminalIcon size={11} className="text-muted-3" />;
  };

  const runCommand = () => {
    const c = cmd.trim();
    if (!c) return;
    // Seed the command into a login shell — byte-identical to typing it, and the
    // shell's PATH resolves CLIs like `vim`, `htop`, `claude`.
    open({ title: c.split(/\s+/)[0], cwd: repoPath, seed: c });
    setCmd("");
  };

  return (
    <ViewChrome
      sidebar={
        <>
          <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
            <span className="text-[12px] font-semibold text-fg-2">Terminals</span>
            <span className="font-mono text-[10.5px] text-muted-4">{tabs.length}</span>
            <button
              type="button"
              onClick={() => open({ title: "shell", cwd: repoPath })}
              title="New terminal"
              aria-label="New terminal"
              className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-line-3 text-muted-2 hover:border-line-strong hover:text-fg-2"
            >
              +
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {shells.length > 0 && (
              <div className="mb-2">
                <SectionHeader label="Shells" count={shells.length} />
                {shells.map((t) => (
                  <SidebarRow
                    key={t.key}
                    active={selectedItem === `shell:${t.key}`}
                    onSelect={() => setActiveKey(t.key)}
                    onClose={() => close(t.key)}
                    icon={
                      <CliIcon
                        size={13}
                        className={
                          selectedItem === `shell:${t.key}`
                            ? "text-[color:var(--accent)]"
                            : "text-muted-3"
                        }
                      />
                    }
                    title={<span className="font-mono">{t.title}</span>}
                  />
                ))}
              </div>
            )}

            {sections.map((s) => {
              const meta = s.project ? projectMeta.get(s.project) : undefined;
              return (
                <div key={s.project ?? "__none__"} className="mb-2">
                  <SectionHeader
                    label={s.project ?? "No project"}
                    count={s.tickets.reduce((n, g) => n + g.tabs.length, 0)}
                    glyph={
                      s.project ? (
                        <ProjectGlyph
                          color={meta?.color ?? "var(--color-muted-4)"}
                          icon={meta?.icon}
                        />
                      ) : undefined
                    }
                  />
                  {s.tickets.map((g) => {
                    const { id, title } = ticketLabel(g.ticket);
                    const active = selectedItem === `ticket:${g.ticket}`;
                    return (
                      <SidebarRow
                        key={g.ticket}
                        active={active}
                        onSelect={() => selectTicket(g)}
                        onClose={() => {
                          for (const t of g.tabs) close(t.key);
                        }}
                        closeLabel="Close all terminals for this ticket"
                        icon={
                          <span
                            className={`font-mono text-[10.5px] ${
                              active ? "text-[color:var(--accent)]" : "text-muted-3"
                            }`}
                          >
                            {id}
                          </span>
                        }
                        title={title ?? undefined}
                        badge={g.tabs.length > 1 ? g.tabs.length : undefined}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="flex-none border-t border-hairline p-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runCommand()}
              placeholder="Run a command… (e.g. htop)"
              aria-label="Run a command in a new terminal"
              className="w-full rounded-md border border-line-3 bg-input px-2.5 py-1.5 font-mono text-[11.5px] text-fg-2 placeholder:text-muted-4"
            />
          </div>

          <SidebarFooter />
        </>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The session tab strip. Height must stay in sync with
            TERMINAL_STRIP_PX — the TerminalLayer overlays everything below it. */}
        <div
          role="tablist"
          onKeyDown={onTabStripKeyDown}
          className={`flex ${CHROME.subBar} flex-none items-stretch overflow-x-auto border-b border-line bg-deep`}
        >
          {orderedStripTabs.map((t) => {
            const meta = sessionMeta(t, extraRows);
            const on = t.key === activeKey;
            return (
              // Presentational wrapper — the tab is the label button, so the close
              // × stays its sibling (a tab's children are presentational to AT).
              <div
                key={t.key}
                role="presentation"
                className="flex flex-none items-stretch border-r border-line text-[11.5px] font-medium"
                style={underlineTabStyle(on)}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setActiveKey(t.key)}
                  className="flex cursor-pointer items-center gap-1.5 pr-1.5 pl-3"
                >
                  {kindIcon(t, meta.kind)}
                  {meta.label}
                </button>
                <span className="flex w-5 items-center justify-center pr-1.5">
                  <button
                    type="button"
                    onClick={() => close(t.key)}
                    title="Close"
                    aria-label={`Close ${meta.label}`}
                    className="flex h-4 w-4 cursor-pointer items-center justify-center rounded text-[13px] leading-none text-muted-3 hover:bg-hover hover:text-fg-2"
                  >
                    ×
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {/* The persistent TerminalLayer overlays this area on /terminal. */}
        <div className="min-w-0 flex-1 bg-panel" />
      </div>
    </ViewChrome>
  );
}

function SectionHeader({
  label,
  count,
  glyph,
}: {
  label: string;
  count: number;
  glyph?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
      {glyph}
      <span className="truncate">{label}</span>
      <span className="text-muted-5">{count}</span>
    </div>
  );
}

/** One sidebar row (a shell session or a ticket item): select on click, with a
 *  hover-revealed close affordance and an optional session-count badge. */
function SidebarRow({
  active,
  onSelect,
  onClose,
  closeLabel = "Close terminal",
  icon,
  title,
  badge,
}: {
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  closeLabel?: string;
  icon: React.ReactNode;
  title?: React.ReactNode;
  badge?: number;
}) {
  return (
    <div
      className="group mb-[3px] flex items-center rounded-md transition-colors hover:bg-hover"
      style={active ? { background: alpha(10) } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-2.5 text-left"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3">{title}</span>
        {badge !== undefined && (
          <span className="flex-none rounded-full bg-hover px-1.5 font-mono text-[9.5px] text-muted-3">
            {badge}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex-none cursor-pointer px-2 py-2 text-[13px] text-muted-5 opacity-0 hover:text-fg-2 group-hover:opacity-100 focus-visible:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
