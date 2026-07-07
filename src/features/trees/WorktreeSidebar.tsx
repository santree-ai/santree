/** Left rail of the Trees tab: all worktrees (tasks) grouped by project, with an
 *  "All agents" overview entry on top and a start-a-task button. Each card shows
 *  its PR status (click → open on GitHub); merged worktrees are dimmed and can be
 *  bulk-selected ("Select merged") and deleted together. */
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import type { SessionState, Worktree, WorktreePr } from "../../bindings";
import { BranchIcon, CheckIcon, TrashIcon } from "../../components/icons";
import { PrChips } from "../../components/PrChip";
import { Button, ConfirmDialog, Dot, Skeleton, Spinner } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { WorktreeStats } from "../../components/WorktreeStats";
import { useSessionStates } from "../../lib/queries";
import { accentActiveStyle, alpha, prStateMeta, sessionStateMeta } from "../../theme/colors";
import { BASE_ID, effectiveSessionState, projectOf, useTrees } from "./model";
import { StartTaskButton } from "./StartTaskButton";

export function WorktreeSidebar() {
  const {
    worktrees,
    prsByWorktree,
    loading,
    baseWorktree,
    activeId,
    setActive,
    showAllAgents,
    selectedWorktrees,
    toggleWorktreeSelected,
    setWorktreeSelection,
    deleteSelected,
  } = useTrees();

  const [confirmOpen, setConfirmOpen] = useState(false);

  // Live Claude session state per worktree, correlated by cwd (the worktree path
  // Claude ran in). Rows are newest-first, so the first seen per cwd is the most
  // recent — keep that one when a worktree has more than one Claude tab.
  const { data: sessionStates = [] } = useSessionStates();
  const sessionByPath = useMemo(() => {
    const map = new Map<string, SessionState>();
    for (const s of sessionStates) if (!map.has(s.cwd)) map.set(s.cwd, s);
    return map;
  }, [sessionStates]);
  // How many worktree sessions are blocked on the user right now — needing input
  // or a tool-permission approval (for the "All agents" attention dot).
  const attentionCount = useMemo(
    () =>
      worktrees.filter((w) => {
        const s = effectiveSessionState(w, sessionByPath.get(w.path));
        return s === "waiting" || s === "permission";
      }).length,
    [worktrees, sessionByPath],
  );

  // A worktree can have several PRs over its life; treat one as "merged" (dimmed /
  // safe to delete) only when *every* PR is merged.
  // Only count worktrees still in the rendered list: a just-deleted worktree is
  // filtered out of `worktrees` optimistically (pendingDeletes), but its PRs
  // linger in the `worktree-prs` cache until the refetch — without this guard the
  // "Select merged N" toolbar would keep counting a row that's already gone.
  const mergedIds = useMemo(() => {
    const visible = new Set(worktrees.map((w) => w.id));
    return [...prsByWorktree.entries()]
      .filter(
        ([id, list]) =>
          visible.has(id) && list.length > 0 && list.every((p) => p.state === "Merged"),
      )
      .map(([id]) => id);
  }, [prsByWorktree, worktrees]);
  const allMergedSelected =
    mergedIds.length > 0 && mergedIds.every((id) => selectedWorktrees.has(id));

  // Group worktrees by project, preserving first-seen order.
  const groups = useMemo(() => {
    const map = new Map<string, Worktree[]>();
    for (const w of worktrees) {
      const key = projectOf(w);
      const list = map.get(key) ?? [];
      list.push(w);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [worktrees]);

  const showActions = mergedIds.length > 0 || selectedWorktrees.size > 0;

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <span className="text-[12px] font-semibold text-fg-2">Worktrees</span>
        <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10.5px] text-muted-2">
          {worktrees.length}
        </span>
        <div className="flex-1" />
        <StartTaskButton />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {baseWorktree && (
          <button
            type="button"
            onClick={() => setActive(BASE_ID)}
            title={`Base branch (${baseWorktree.branch})`}
            className="mb-1 flex w-full cursor-pointer items-center gap-2 rounded-[9px] px-[11px] py-2 text-left text-[12px] hover:bg-hover"
            style={{
              background: activeId === BASE_ID ? alpha(8) : "transparent",
              color: activeId === BASE_ID ? "var(--accent)" : "var(--color-muted-2)",
            }}
          >
            <BranchIcon size={13} className="flex-none" />
            <span className="min-w-0 flex-1 truncate font-mono">{baseWorktree.branch}</span>
            {baseWorktree.dirty && (
              <span title="Uncommitted changes" className="text-status-amber">
                ●
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={showAllAgents}
          className="mb-2 flex w-full cursor-pointer items-center gap-2 rounded-[9px] px-[11px] py-2 text-left text-[12px] hover:bg-hover"
          style={{
            background: activeId === "" ? alpha(8) : "transparent",
            color: activeId === "" ? "var(--accent)" : "var(--color-muted-2)",
          }}
        >
          ⊞ All agents
          <div className="ml-auto flex items-center gap-1.5">
            {attentionCount > 0 && (
              <span
                title={`${attentionCount} session${attentionCount === 1 ? "" : "s"} need your attention`}
                className="flex items-center"
              >
                <Dot color={sessionStateMeta.waiting.color} size={6} glow />
              </span>
            )}
            <span className="font-mono text-[9.5px] text-muted-4">{worktrees.length}</span>
          </div>
        </button>

        {loading && groups.length === 0 && <SidebarSkeleton />}

        {groups.map(([project, list]) => (
          <div key={project} className="mb-1.5">
            <div className="px-2 pt-1 pb-1 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
              {project}
            </div>
            {list.map((w) => (
              <WorktreeEntry
                key={w.id}
                worktree={w}
                active={w.id === activeId}
                prs={prsByWorktree.get(w.id) ?? []}
                selected={selectedWorktrees.has(w.id)}
                sessionState={sessionByPath.get(w.path)}
                onOpen={() => setActive(w.id)}
                onToggleSelect={() => toggleWorktreeSelected(w.id)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Selection/bulk actions live at the BOTTOM (above the footer, like the
          Issues launch tray) so appearing on select shrinks the scroll list from
          the bottom instead of pushing the whole list down from the top. */}
      {showActions && (
        <div className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-1.5">
          {mergedIds.length > 0 && (
            <Button
              size="sm"
              onClick={() => setWorktreeSelection(allMergedSelected ? [] : mergedIds)}
              title="Select all worktrees whose PR is merged"
              style={allMergedSelected ? accentActiveStyle() : undefined}
            >
              <Dot color={prStateMeta.Merged.color} size={6} />
              Select merged {mergedIds.length}
            </Button>
          )}
          <div className="flex-1" />
          {selectedWorktrees.size > 0 && (
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              className="hover:!text-status-red"
            >
              <TrashIcon size={12} />
              Delete {selectedWorktrees.size}
            </Button>
          )}
        </div>
      )}

      <SidebarFooter />

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="Delete worktrees"
        confirmLabel={`Delete ${selectedWorktrees.size}`}
        busyLabel="Deleting…"
        message={
          <>
            Delete {selectedWorktrees.size} worktree{selectedWorktrees.size === 1 ? "" : "s"} and
            their branches? Any uncommitted changes will be lost.
          </>
        }
        // Optimistic + background: vanish now, delete in the background; on
        // failure they reappear (rollback) with an error toast.
        onConfirm={() => {
          deleteSelected();
          return Promise.resolve();
        }}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

function WorktreeEntry({
  worktree: w,
  active,
  prs,
  selected,
  sessionState,
  onOpen,
  onToggleSelect,
}: {
  worktree: Worktree;
  active: boolean;
  prs: WorktreePr[];
  selected: boolean;
  sessionState: SessionState | undefined;
  onOpen: () => void;
  onToggleSelect: () => void;
}) {
  // Reconcile the hook state with liveness — a non-running worktree reads
  // "exited" even if the last hook said active/waiting.
  const state = effectiveSessionState(w, sessionState);
  const session = state ? sessionStateMeta[state] : undefined;
  // Dimmed only when fully merged (every PR) — a worktree with any open PR stays lit.
  const merged = prs.length > 0 && prs.every((p) => p.state === "Merged");
  const style: CSSProperties = {
    border: `1px solid ${active ? alpha(40) : "transparent"}`,
    background: active ? alpha(6) : "transparent",
    // Merged worktrees are done and safe to delete — dim them so they recede.
    opacity: merged && !selected ? 0.55 : 1,
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: card holds nested buttons (select + PR link), so it can't be a <button>
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative mb-[5px] flex w-full cursor-pointer gap-2 rounded-[9px] px-[11px] py-2.5 text-left transition-colors hover:bg-hover"
      style={style}
    >
      {!w.pending && (
        // Always visible (an empty outlined box when unselected), matching the
        // Issues/Triage rows — not hover-gated, so the select affordance is
        // discoverable without hovering every card.
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          aria-label={selected ? "Deselect worktree" : "Select worktree"}
          className="mt-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-[4px] border transition-colors"
          style={
            selected
              ? { background: "var(--accent-fill)", borderColor: "var(--accent-fill)" }
              : { borderColor: "var(--color-line-strong)" }
          }
        >
          {selected && <CheckIcon size={10} className="text-[var(--on-accent)]" />}
        </button>
      )}

      <div className="min-w-0 flex-1">
        {w.pending ? (
          // Optimistic placeholder while git creates the worktree — no branch/stats
          // yet, so show the title and a "creating" line instead.
          <>
            <div className="mb-1.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-fg-2">
              {w.title}
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-3">
              <Spinner size={9} />
              Creating workspace…
            </div>
          </>
        ) : (
          <>
            {/* Lead with the live Claude session state (from the session-signal
                hooks) as a leading dot, then the ticket ID, then the PR badge. */}
            <div className="mb-[5px] flex items-center gap-1.5">
              {session && (
                <span
                  className="flex-none"
                  title={
                    (state === "waiting" || state === "permission") && sessionState?.message
                      ? `${session.label}: ${sessionState.message}`
                      : session.label
                  }
                >
                  <Dot color={session.color} size={7} glow={session.glow} />
                </span>
              )}
              <span className="min-w-0 flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-fg-2">
                {w.id}
              </span>
              <PrChips prs={prs} />
            </div>
            <div className="mb-1.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-muted">
              {w.title}
            </div>
            {/* Wrap: with several stats (adds/dels/ahead/behind/clean) the row can
                be wider than the narrow sidebar — let it reflow to a second line
                instead of overflowing the card and clipping "clean". */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-muted-4">
              {session && (
                <span style={{ color: session.color }} title={session.label}>
                  {session.short}
                </span>
              )}
              <WorktreeStats worktree={w} showClean />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Placeholder rows shown while the first worktrees fetch is in flight. */
function SidebarSkeleton() {
  return (
    <div className="mt-1.5">
      <div className="px-2 pt-1 pb-1.5">
        <Skeleton className="h-2.5 w-20" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="mb-[5px] rounded-[9px] px-[11px] py-2.5">
          <Skeleton className="mb-2 h-3 w-16" />
          <Skeleton className="mb-2 h-3 w-4/5" />
          <Skeleton className="h-2.5 w-24" />
        </div>
      ))}
    </div>
  );
}
