/** Left rail of the Trees tab: all worktrees (tasks) grouped by project, with an
 *  "All agents" overview entry on top and a start-a-task button. Each card shows
 *  its PR status (click → open on GitHub); merged worktrees are dimmed and can be
 *  bulk-selected ("Select merged") and deleted together. Within a project, a
 *  worktree branched off a sibling is indented under it (see `stackWorktrees`). */
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import type { SessionState, Worktree, WorktreePr } from "../../bindings";
import { BranchIcon, CheckIcon, DownloadIcon, TrashIcon } from "../../components/icons";
import { PrChips } from "../../components/PrChip";
import { Button, ConfirmDialog, Dot, Skeleton, Spinner } from "../../components/primitives";
import { SidebarFooter } from "../../components/SidebarFooter";
import { WorktreeStats } from "../../components/WorktreeStats";
import { useSessionByPath, useUpdateBaseBranch } from "../../lib/queries";
import { accentActiveStyle, alpha, prStateMeta, sessionStateMeta } from "../../theme/colors";
import { BASE_ID, effectiveSessionState, projectOf, useTrees } from "./model";
import { StartTaskButton } from "./StartTaskButton";

/** Width of one nesting level's connector gutter. Deliberately small — enough to
 *  read the stack at a glance without carving into a card that already holds a
 *  ticket id, PR chips and git stats. */
const INDENT_PX = 14;
/** Deepest level that still indents. A long chain keeps its order but stops
 *  stepping in, so it can't squeeze the cards at the bottom of a stack. */
const MAX_DEPTH = 3;

/** The left gutter that ties a stacked worktree to the one it branched off: a
 *  faint vertical spine per ancestor level, and an elbow (`└`) into the card at
 *  its own level. Same guide-line vocabulary as the file tree's `IndentGuides`,
 *  so nesting reads the same across the app. Purely decorative — the card holds
 *  all the interaction. Sits as a flex sibling of the card (not a margin on it),
 *  so the card keeps its full width and its border can't be clipped by overflow. */
function StackConnector({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span
      className="relative flex flex-none self-stretch"
      aria-hidden
      style={{ width: depth * INDENT_PX }}
    >
      {Array.from({ length: depth }, (_, i) => {
        const own = i === depth - 1;
        return (
          <span key={i} className="relative" style={{ width: INDENT_PX }}>
            {/* Vertical spine: full height for an ancestor level; only down to the
                elbow corner at the card's own level. */}
            <span
              className="absolute top-0 left-0 border-line-2 border-l"
              style={{ height: own ? "50%" : "100%" }}
            />
            {/* Elbow tick into the card, at the card's own level only. */}
            {own && (
              <span
                className="absolute top-1/2 left-0 border-line-2 border-t"
                style={{ width: INDENT_PX }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

/** The repo's base branch (main/master) at the top of the rail. Keeping the local
 *  base in sync with origin is a repo-level action — it fast-forwards the checkout
 *  itself and never touches a worktree — so it lives here rather than in each
 *  worktree's bottom bar. `behind` is how many commits origin has that the local
 *  branch doesn't, so the button only offers itself when there's something to get. */
function BaseEntry({ worktree, active }: { worktree: Worktree; active: boolean }) {
  const { repo, setActive } = useTrees();
  const { mutate: updateBase, isPending } = useUpdateBaseBranch(repo);
  const behind = worktree.behind;

  return (
    // Same shape as WorktreeEntry: the row's own action is a stretched button, so
    // the update action can be a real sibling button rather than an illegal nested
    // one (ARIA makes a button's children presentational).
    <div
      className="relative mb-1 flex items-center gap-2 rounded-[9px] px-[11px] py-2 text-[12px] hover:bg-hover"
      style={{
        background: active ? alpha(8) : "transparent",
        color: active ? "var(--accent)" : "var(--color-muted-2)",
      }}
    >
      <button
        type="button"
        onClick={() => setActive(BASE_ID)}
        aria-label={`Base branch ${worktree.branch}`}
        title={`Base branch (${worktree.branch})`}
        className="absolute inset-0 cursor-pointer rounded-[9px]"
      />
      <BranchIcon size={13} className="flex-none" />
      <span className="min-w-0 flex-1 truncate font-mono">{worktree.branch}</span>
      {worktree.dirty && (
        <span title="Uncommitted changes" className="relative text-status-amber">
          ●
        </span>
      )}
      {behind > 0 && (
        <button
          type="button"
          disabled={isPending}
          onClick={() => updateBase(BASE_ID)}
          title={`Fast-forward ${worktree.branch} from origin (${behind} behind)`}
          className="relative flex flex-none cursor-pointer items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-status-amber hover:bg-hover hover:text-accent"
        >
          {isPending ? <Spinner size={9} /> : <DownloadIcon />}↓{behind}
        </button>
      )}
    </div>
  );
}

/**
 * Order one project's worktrees so a stacked one sits directly under the worktree
 * it branched off, with the depth to indent it by.
 *
 * A worktree's parent is the one whose branch it uses as its base — the same fact
 * the bottom bar's base chip shows. The lookup is per group, so a parent in another
 * project simply isn't found and the child renders flat rather than being dragged
 * out of its own band. Roots (and siblings) keep the list's original order.
 *
 * Exported for testing — see WorktreeSidebar.test.ts.
 */
export function stackWorktrees(list: Worktree[]): { worktree: Worktree; depth: number }[] {
  // Pending placeholders have no branch yet; an empty key would make them each
  // other's parents.
  const byBranch = new Map<string, Worktree>();
  for (const w of list) if (w.branch) byBranch.set(w.branch, w);

  const childrenOf = new Map<string, Worktree[]>();
  const roots: Worktree[] = [];
  for (const w of list) {
    const parent = w.baseBranch ? byBranch.get(w.baseBranch) : undefined;
    if (!parent || parent.id === w.id) {
      roots.push(w);
      continue;
    }
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), w]);
  }

  const out: { worktree: Worktree; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (w: Worktree, depth: number) => {
    if (seen.has(w.id)) return; // a cycle would otherwise recurse forever
    seen.add(w.id);
    out.push({ worktree: w, depth: Math.min(depth, MAX_DEPTH) });
    for (const child of childrenOf.get(w.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Only reachable if the base branches form a cycle — every worktree still has to
  // render, so fall back to a flat row rather than dropping it from the sidebar.
  for (const w of list) {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      out.push({ worktree: w, depth: 0 });
    }
  }
  return out;
}

export function WorktreeSidebar() {
  const {
    worktrees,
    prsByWorktree,
    loading,
    baseWorktree,
    activeId,
    setActive,
    selectedWorktrees,
    toggleWorktreeSelected,
    setWorktreeSelection,
    deleteSelected,
  } = useTrees();

  const [confirmOpen, setConfirmOpen] = useState(false);

  // Live Claude session state per worktree, correlated by cwd (the worktree path
  // Claude ran in).
  const sessionByPath = useSessionByPath();

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

  // Group worktrees by project, preserving first-seen order, then nest each
  // group's stacked worktrees under the one they branched off.
  const groups = useMemo(() => {
    const map = new Map<string, Worktree[]>();
    for (const w of worktrees) {
      const key = projectOf(w);
      const list = map.get(key) ?? [];
      list.push(w);
      map.set(key, list);
    }
    return [...map.entries()].map(([project, list]) => [project, stackWorktrees(list)] as const);
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
        {baseWorktree && <BaseEntry worktree={baseWorktree} active={activeId === BASE_ID} />}

        {loading && groups.length === 0 && <SidebarSkeleton />}

        {groups.map(([project, list]) => (
          <div key={project} className="mb-1.5">
            <div className="px-2 pt-1 pb-1 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
              {project}
            </div>
            {list.map(({ worktree: w, depth }) => (
              <WorktreeEntry
                key={w.id}
                worktree={w}
                depth={depth}
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
  depth,
  active,
  prs,
  selected,
  sessionState,
  onOpen,
  onToggleSelect,
}: {
  worktree: Worktree;
  /** Nesting level under the worktree this one branched off (see `stackWorktrees`). */
  depth: number;
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
  // Every card carries an edge, not just the active one. The stack connector's elbow
  // has to *land* on something: against a borderless parent the spine appeared to
  // start in mid-air, which is precisely the hierarchy the indent exists to show.
  // Inactive cards use the same hairline as the connector (and as every other card
  // in the app) so the rail reads as one system; active still wins with the accent.
  const cardStyle: CSSProperties = {
    border: `1px solid ${active ? alpha(40) : "var(--color-line-2)"}`,
    background: active ? alpha(6) : "transparent",
  };
  return (
    // Row = connector gutter + card. The indent lives in the gutter, never as a
    // margin on the card — a margined `w-full` card overflows the rail and clips
    // its right border (and the active highlight) behind the sidebar edge.
    <div
      className="mb-[5px] flex items-stretch"
      // Merged worktrees are done and safe to delete — dim the whole row so it recedes.
      style={{ opacity: merged && !selected ? 0.55 : 1 }}
    >
      <StackConnector depth={depth} />
      <div
        className="group relative flex min-w-0 flex-1 cursor-pointer gap-2 rounded-[9px] px-[11px] py-2.5 text-left transition-colors hover:bg-hover"
        style={cardStyle}
      >
        {/* The card's own action is a button stretched over it, not a `role="button"`
          wrapper: the select box and the PR chips are real buttons, and ARIA makes
          a button's children presentational — nested inside one they'd vanish from
          the a11y tree. Those two stay positioned so they paint (and hit-test)
          above this. */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${w.id}`}
          className="absolute inset-0 cursor-pointer rounded-[9px]"
        />
        {!w.pending && (
          // Always visible (an empty outlined box when unselected), matching the
          // Issues/Triage rows — not hover-gated, so the select affordance is
          // discoverable without hovering every card.
          <button
            type="button"
            onClick={onToggleSelect}
            aria-label={selected ? "Deselect worktree" : "Select worktree"}
            className="relative mt-px flex h-3.5 w-3.5 flex-none items-center justify-center rounded-[4px] border transition-colors"
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
                  // `relative` so it sits above the stretched open-button and can
                  // still be hovered for its tooltip (the message a waiting session
                  // is blocked on).
                  <span
                    className="relative flex-none"
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
                {prs.length > 0 && (
                  <span className="relative flex flex-none items-center">
                    <PrChips prs={prs} />
                  </span>
                )}
              </div>
              <div className="mb-1.5 overflow-hidden text-[11.5px] leading-[1.3] text-ellipsis whitespace-nowrap text-muted">
                {w.title}
              </div>
              {/* Wrap: with several stats (adds/dels/ahead/behind/clean) the row can
                be wider than the narrow sidebar — let it reflow to a second line
                instead of overflowing the card and clipping "clean". */}
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10px] text-muted-4">
                {session && (
                  <span className="relative" style={{ color: session.color }} title={session.label}>
                    {session.short}
                  </span>
                )}
                <WorktreeStats worktree={w} showClean />
              </div>
            </>
          )}
        </div>
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
