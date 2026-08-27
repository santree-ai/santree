/**
 * The Agents panel — santree's control surface.
 *
 * Every Claude session the app has launched, across **every repo you're working
 * in**, grouped by what it wants from you. This is the landing view, so it
 * answers one question on open: *where do I act?*
 *
 * Nothing here is a navigable tree — the groups are the structure — so the whole
 * width goes to the cards, and the only chrome the view owns is its header row:
 * the multi-repo picker, a filter box and the agent counts.
 */
import { useMemo, useState } from "react";

import type { WorktreePr } from "../../bindings";
import { AgentsIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "../../components/icons";
import {
  Dropdown,
  EmptyState,
  ListSkeleton,
  MENU_ITEM,
  ProjectGlyph,
} from "../../components/primitives";
import { useSessionUsageLive, useWorktreePrsByRepo } from "../../lib/queries";
import { PROJECT_FALLBACK, palette, sessionStateMeta } from "../../theme/colors";
import { AgentCard } from "./AgentCard";
import { AgentPeek } from "./AgentPeek";
import {
  type AgentBucket,
  BUCKET_HINT,
  BUCKET_LABEL,
  filterAgents,
  groupAgents,
  groupAgentsByProject,
  repoLabel,
} from "./registry";
import { type RepoFilter, useAgentEntries, useRepoFilter } from "./useAgents";
import { useOpenAgent } from "./useOpenAgent";

/** The colour of the state a group collects. */
const BUCKET_COLOR: Record<AgentBucket, string> = {
  attention: sessionStateMeta.waiting.color,
  working: sessionStateMeta.active.color,
  idle: sessionStateMeta.idle.color,
  detached: palette.muted,
  done: palette.muted,
};

/** Multi-select over the registered repos — this panel spans repos, so it owns
 *  its own scope control instead of following the app-wide repo switcher. */
function RepoPicker({ filter }: { filter: RepoFilter }) {
  const { all, shown, isShown, toggle, showAll, allShown } = filter;
  const label = allShown ? "All repos" : `${shown.length} of ${all.length} repos`;

  return (
    <Dropdown
      menuClassName="w-64 overflow-hidden"
      trigger={(open) => (
        <button
          type="button"
          onClick={open}
          className="flex flex-none cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 py-1 text-[11.5px] text-muted-2 transition-colors hover:border-line-strong hover:text-fg-2"
        >
          {label}
          <ChevronDownIcon size={10} className="text-muted-4" />
        </button>
      )}
    >
      {() => (
        <>
          {all.map((repo) => {
            const on = isShown(repo);
            return (
              <button
                key={repo}
                type="button"
                // Checkbox, not plain item: each row toggles a repo on/off and
                // the menu stays open, which is what `menuitemcheckbox` announces.
                role="menuitemcheckbox"
                onClick={() => toggle(repo)}
                aria-checked={on}
                className={`${MENU_ITEM} justify-between gap-2`}
              >
                <span className="min-w-0 truncate">{repoLabel(repo)}</span>
                {on && (
                  <CheckIcon size={12} className="flex-none text-[color:var(--accent-text)]" />
                )}
              </button>
            );
          })}
          {!allShown && (
            <button type="button" role="menuitem" onClick={showAll} className={MENU_ITEM}>
              Show all
            </button>
          )}
        </>
      )}
    </Dropdown>
  );
}

export function AgentsView() {
  const filter = useRepoFilter();
  const entries = useAgentEntries(filter.shown, filter.all);
  const openAgent = useOpenAgent();
  const prsByRepo = useWorktreePrsByRepo(filter.shown);
  const { data: usage } = useSessionUsageLive();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // PRs are keyed by (repo, issue) — two repos can both have an AK-1.
  const prsByKey = useMemo(() => {
    const map = new Map<string, WorktreePr[]>();
    for (const [repo, prs] of prsByRepo) {
      for (const p of prs) {
        const key = `${repo}\0${p.issueId}`;
        const at = map.get(key) ?? [];
        at.push(p);
        map.set(key, at);
      }
    }
    return map;
  }, [prsByRepo]);
  const prsFor = (repo: string | null, ticket: string | null) =>
    repo && ticket ? (prsByKey.get(`${repo}\0${ticket}`) ?? []) : [];

  const usedPctBySession = useMemo(
    () => new Map((usage ?? []).map((u) => [u.sessionId, u.usedPct])),
    [usage],
  );

  const all = entries ?? [];
  const groups = useMemo(() => groupAgents(filterAgents(all, query)), [all, query]);
  const selected = all.find((e) => e.sessionId === selectedId) ?? null;
  const blocked = all.filter((e) => e.bucket === "attention").length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
      {/* The view's own 44px header — the app shell owns the window chrome. */}
      <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line px-3">
        <span className="flex-none text-[12.5px] font-semibold text-fg-2">Agents</span>
        <RepoPicker filter={filter} />
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <SearchIcon size={13} className="flex-none text-muted-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter agents…"
            aria-label="Filter agents"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg-2 outline-none placeholder:text-muted-4"
          />
        </label>
        <span className="flex-none font-mono text-[10.5px] text-muted-4">
          {all.length} {all.length === 1 ? "agent" : "agents"}
          {blocked > 0 && (
            <>
              {" · "}
              <span style={{ color: sessionStateMeta.waiting.color }}>{blocked} need you</span>
            </>
          )}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Loading is not emptiness: until the first read lands, show the shape
              of a list rather than asserting there are no agents. */}
        {entries === undefined ? (
          <ListSkeleton rows={5} className="flex-1 p-3" />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<AgentsIcon className="text-muted-4" />}
            title={all.length === 0 ? "No agents running" : "Nothing matches that filter"}
            subtitle={
              all.length === 0
                ? "Start a task in Trees, or investigate a ticket in Triage. Every session shows up here."
                : undefined
            }
          />
        ) : (
          <div data-agent-list className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
            {groups.map((group) => (
              <section key={group.bucket} className="flex flex-col gap-2.5">
                <h2 className="flex items-baseline gap-2 px-1 font-mono text-[10px] tracking-wide text-muted-3">
                  <span
                    aria-hidden
                    className="h-[3px] w-[3px] self-center rounded-full"
                    style={{ background: BUCKET_COLOR[group.bucket] }}
                  />
                  {BUCKET_LABEL[group.bucket]}
                  <span className="text-muted-4">{group.entries.length}</span>
                  {BUCKET_HINT[group.bucket] && (
                    <span className="truncate font-sans text-[10.5px] text-muted-4">
                      {BUCKET_HINT[group.bucket]}
                    </span>
                  )}
                </h2>
                {groupAgentsByProject(group.entries).map((project) => (
                  <div key={project.project} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-1.5 px-1 font-mono text-[9.5px] tracking-[.05em] text-muted-4 uppercase">
                      <ProjectGlyph
                        color={project.color ?? PROJECT_FALLBACK}
                        icon={project.icon}
                        size={5}
                      />
                      <span className="truncate">{project.project}</span>
                      <span className="text-muted-5">{project.entries.length}</span>
                    </div>
                    <div className="overflow-hidden rounded-[9px] border border-line-2 bg-deep divide-y divide-line">
                      {project.entries.map((entry) => (
                        <AgentCard
                          key={entry.sessionId}
                          entry={entry}
                          selected={entry.sessionId === selectedId}
                          usedPct={usedPctBySession.get(entry.sessionId) ?? null}
                          prs={prsFor(entry.repo, entry.ticket)}
                          onSelect={() => setSelectedId(entry.sessionId)}
                          onOpen={() => entry.openable && openAgent(entry)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}

        {selected && (
          <AgentPeek
            // Remount per session so the reply box resets with the selection.
            key={selected.sessionId}
            entry={selected}
            prs={prsFor(selected.repo, selected.ticket)}
            onOpen={() => openAgent(selected)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
