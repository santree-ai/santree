/**
 * Left rail of the Reviews tab: the org-scoped PR inbox split into categories,
 * mirroring how the Trees sidebar groups worktrees by project.
 *
 *  1. **My PRs** — the viewer's open PRs, sub-grouped by repository.
 *  2. **Review requests** — PRs *directly* requesting the viewer's review.
 *  3. one block **per team** the viewer is on that has open requests — these are
 *     lower-signal than a direct request, so each block is collapsible (persisted).
 *
 * `ReviewsSidebar` wires the view-model; `ReviewsSidebarView` is the pure render
 * (split out so it can be tested without AppContext/router).
 */
import { useState } from "react";

import type { ReviewInbox, ReviewPr, TeamReviews } from "../../bindings";
import { ChevronDownIcon, ChevronRightIcon, ListIcon } from "../../components/icons";
import { Dot, EmptyState, Skeleton } from "../../components/primitives";
import { useMergeQueue } from "../../lib/queries";
import {
  accentActiveStyle,
  alpha,
  checkRollupMeta,
  mergeQueueMeta,
  reviewDecisionMeta,
} from "../../theme/colors";
import { useReviewsModel } from "./model";

/** Short "name" from an "owner/name" slug. */
function repoName(slug: string): string {
  return slug.split("/").pop() ?? slug;
}

/** Which team sections the user has folded, persisted across restarts — team
 *  requests are lower-signal than direct ones, so a collapse should stick. */
const TEAMS_COLLAPSED_KEY = "santree-reviews-collapsed-teams";

function readCollapsedTeams(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(TEAMS_COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

export function ReviewsSidebar() {
  const { repo, inbox, loading, allPrs, activeId, setActive, showMergeQueue, openMergeQueue } =
    useReviewsModel();
  const { data: queue } = useMergeQueue(repo);
  return (
    <ReviewsSidebarView
      inbox={inbox}
      loading={loading}
      total={allPrs.length}
      activeId={showMergeQueue ? null : activeId}
      onSelect={setActive}
      onOpenMergeQueue={openMergeQueue}
      mergeQueueActive={showMergeQueue}
      mergeQueueCount={queue?.entries.length ?? 0}
      mergeQueueHasMine={queue?.entries.some((e) => e.isMine) ?? false}
    />
  );
}

export function ReviewsSidebarView({
  inbox,
  loading,
  total,
  activeId,
  onSelect,
  onOpenMergeQueue,
  mergeQueueActive = false,
  mergeQueueCount = 0,
  mergeQueueHasMine = false,
}: {
  inbox: ReviewInbox | undefined;
  loading: boolean;
  total: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Opens the merge-queue panel; when omitted the button is hidden (tests). */
  onOpenMergeQueue?: () => void;
  mergeQueueActive?: boolean;
  mergeQueueCount?: number;
  /** True when the viewer has a PR in the queue — nudges the button to accent. */
  mergeQueueHasMine?: boolean;
}) {
  const [collapsedTeams, setCollapsedTeams] = useState(readCollapsedTeams);
  const toggleTeam = (slug: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (!next.delete(slug)) next.add(slug);
      localStorage.setItem(TEAMS_COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Group "My PRs" by repository, preserving first-seen order.
  const mineByRepo = new Map<string, ReviewPr[]>();
  for (const pr of inbox?.mine ?? []) {
    const list = mineByRepo.get(pr.repo) ?? [];
    list.push(pr);
    mineByRepo.set(pr.repo, list);
  }

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <span className="text-[12px] font-semibold text-fg-2">Reviews</span>
        <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10.5px] text-muted-2">
          {total}
        </span>
      </div>

      {onOpenMergeQueue && (
        <div className="flex-none border-b border-hairline p-2">
          <button
            type="button"
            onClick={onOpenMergeQueue}
            title="Show the repo's merge queue"
            className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition-colors hover:bg-hover"
            style={
              mergeQueueActive
                ? accentActiveStyle()
                : { border: "1px solid transparent", background: "transparent" }
            }
          >
            <ListIcon
              size={13}
              className={mergeQueueActive ? "text-[color:var(--accent)]" : "text-muted-2"}
            />
            <span
              className="text-[12px] font-medium"
              style={{ color: mergeQueueActive ? "var(--accent)" : "var(--color-fg-2)" }}
            >
              Merge queue
            </span>
            {mergeQueueHasMine && !mergeQueueActive && <Dot color="var(--accent)" size={6} />}
            {mergeQueueCount > 0 && (
              <span className="ml-auto rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10px] text-muted-2">
                {mergeQueueCount}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {loading && total === 0 && <SidebarSkeleton />}

        {!loading && total === 0 && (
          <div className="mt-10">
            <EmptyState
              title="No open pull requests"
              subtitle="Authored PRs and review requests for this org will show up here."
            />
          </div>
        )}

        {[...mineByRepo].length > 0 && (
          <Section title="My PRs">
            {[...mineByRepo].map(([repo, prs]) => (
              <div key={repo} className="mb-1">
                <div className="px-2 pt-1 pb-1 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
                  {repoName(repo)}
                </div>
                {prs.map((pr) => (
                  <PrRow key={pr.id} pr={pr} active={pr.id === activeId} onSelect={onSelect} />
                ))}
              </div>
            ))}
          </Section>
        )}

        {(inbox?.requested.length ?? 0) > 0 && (
          <Section title="Review requests">
            {inbox?.requested.map((pr) => (
              <PrRow key={pr.id} pr={pr} active={pr.id === activeId} onSelect={onSelect} showRepo />
            ))}
          </Section>
        )}

        {inbox?.teams.map((team) => (
          <TeamSection
            key={team.slug}
            team={team}
            open={!collapsedTeams.has(team.slug)}
            onToggle={() => toggleTeam(team.slug)}
          >
            {team.prs.map((pr) => (
              <PrRow key={pr.id} pr={pr} active={pr.id === activeId} onSelect={onSelect} showRepo />
            ))}
          </TeamSection>
        ))}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="px-2 pb-1 text-[11px] font-semibold text-fg-2">{title}</div>
      {children}
    </div>
  );
}

/** A per-team block: unlike the personal sections it folds away, since a team
 *  request isn't necessarily for the viewer to act on. Rows are plain buttons
 *  (no effects), so conditional rendering on collapse is safe. */
function TeamSection({
  team,
  open,
  onToggle,
  children,
}: {
  team: TeamReviews;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="mb-1 flex w-full cursor-pointer items-center gap-1 rounded-[6px] px-2 py-0.5 text-left text-[11px] font-semibold text-fg-2 transition-colors hover:bg-hover"
      >
        <Chevron size={10} className="flex-none text-muted-3" />
        <span className="truncate">Team · {team.name}</span>
        <span className="ml-auto font-mono text-[10px] font-normal text-muted-4">
          {team.prs.length}
        </span>
      </button>
      {open && children}
    </div>
  );
}

function PrRow({
  pr,
  active,
  onSelect,
  showRepo = false,
}: {
  pr: ReviewPr;
  active: boolean;
  onSelect: (id: string) => void;
  showRepo?: boolean;
}) {
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];

  return (
    <button
      type="button"
      onClick={() => onSelect(pr.id)}
      className="mb-[3px] flex w-full cursor-pointer flex-col gap-[5px] rounded-[9px] px-[11px] py-2 text-left transition-colors hover:bg-hover"
      style={
        active
          ? accentActiveStyle()
          : { border: "1px solid transparent", background: "transparent" }
      }
    >
      <div className="flex items-center gap-1.5">
        <Dot color={decision.color} size={6} />
        <span className="font-mono text-[10.5px] text-muted-2">#{pr.number}</span>
        {pr.isDraft && (
          <span className="rounded-[4px] border border-line-3 px-1 font-mono text-[8.5px] text-muted-3 uppercase">
            draft
          </span>
        )}
        {pr.isInMergeQueue && (
          <span
            className="rounded-[4px] px-1 font-mono text-[8.5px] uppercase"
            style={{
              color: mergeQueueMeta.color,
              border: `1px solid ${alpha(40, mergeQueueMeta.color)}`,
            }}
            title={mergeQueueMeta.label}
          >
            queued
          </span>
        )}
        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: checks.color }}
          title={checks.label}
        >
          {checks.glyph}
        </span>
      </div>
      <div
        className="overflow-hidden text-[12px] leading-[1.3] text-ellipsis whitespace-nowrap"
        style={{ color: active ? "var(--accent)" : "var(--color-fg-2)" }}
      >
        {pr.title}
      </div>
      <div className="flex items-center gap-2 font-mono text-[10px] text-muted-4">
        {showRepo && <span className="truncate">{repoName(pr.repo)}</span>}
        <span>
          <span className="text-status-green">+{pr.additions}</span>{" "}
          <span className="text-status-red">−{pr.deletions}</span>
        </span>
        {pr.commentCount > 0 && <span>💬 {pr.commentCount}</span>}
      </div>
    </button>
  );
}

function SidebarSkeleton() {
  return (
    <div className="mt-1.5">
      <div className="px-2 pt-1 pb-1.5">
        <Skeleton className="h-2.5 w-16" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="mb-[5px] rounded-[9px] px-[11px] py-2.5">
          <Skeleton className="mb-2 h-2.5 w-12" />
          <Skeleton className="mb-2 h-3 w-4/5" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}
