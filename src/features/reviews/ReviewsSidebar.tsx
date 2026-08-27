/**
 * Left rail of the Reviews tab: the org-scoped PR inbox, ordered by what you
 * should pick up next rather than by who owns it.
 *
 * The default (`category`) grouping keeps ownership clear:
 *
 *  1. **My PRs** — your own open PRs, sub-grouped by repository.
 *  2. **Needs your review** — direct requests still awaiting your verdict.
 *  3. one block **per team** you're on with open requests — lower-signal than a
 *     direct request, so each folds (persisted).
 *  4. **Reviewed, waiting on author** — completed direct requests, kept last.
 *
 * Two selects in the header re-cut the same list by Linear project or by repo,
 * and re-order it by wait / recency / size. Under those cuts the category signal
 * would be lost, so directly-requested rows carry an `@you` pill.
 *
 * `ReviewsSidebar` wires the view-model; `ReviewsSidebarView` is the pure render
 * (split out so it can be tested without AppContext/router).
 */
import { useState } from "react";

import type { ReviewInbox, ReviewPr, TeamReviews, TicketRef } from "../../bindings";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  ListIcon,
  MessageSquareIcon,
  SparklesIcon,
} from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import {
  ChevronSelect,
  Dot,
  EmptyState,
  ProjectGlyph,
  Skeleton,
} from "../../components/primitives";
import {
  ChangeSizeBars,
  MilestoneHeading,
  PriorityBars,
  ProjectDueDate,
  showMilestoneGroups,
} from "../../components/WorkSignals";
import { useMergeQueue } from "../../lib/queries";
import {
  accentActiveStyle,
  alpha,
  checkRollupMeta,
  mergeQueueMeta,
  PROJECT_FALLBACK,
  palette,
  reviewAgeColor,
  reviewDecisionMeta,
} from "../../theme/colors";
import {
  type Grouping,
  groupPrs,
  groupPrsByMilestone,
  repoName,
  type SortMode,
  sortPrs,
  splitByStance,
  stackPrs,
  waitingDays,
  waitingLabel,
} from "./grouping";
import { useReviewsModel } from "./model";

/** Which sidebar sections the user has collapsed, persisted across restarts. */
const COLLAPSED_KEY = "santree-reviews-collapsed-teams";
const MINE_KEY = "category:mine";
const REQUESTED_KEY = "category:requested";

/** Section key for the "you've already reviewed these" block, sharing the same
 *  persisted collapse store as the team blocks. */
const REVIEWED_KEY = "category:reviewed";

function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    const keys = Array.isArray(raw) ? raw.filter((s) => typeof s === "string") : [];
    return new Set(keys.map((key) => (key === "\0reviewed" ? REVIEWED_KEY : key)));
  } catch {
    return new Set();
  }
}

export function ReviewsSidebar() {
  const {
    repo,
    inbox,
    loading,
    allPrs,
    activeId,
    setActive,
    showMergeQueue,
    openMergeQueue,
    grouping,
    setGrouping,
    sort,
    setSort,
    ticketFor,
  } = useReviewsModel();
  const { data: queue } = useMergeQueue(repo);
  return (
    <ReviewsSidebarView
      inbox={inbox}
      loading={loading}
      total={allPrs.length}
      activeId={showMergeQueue ? null : activeId}
      onSelect={setActive}
      grouping={grouping}
      onGrouping={setGrouping}
      sort={sort}
      onSort={setSort}
      ticketFor={ticketFor}
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
  grouping = "category",
  onGrouping,
  sort = "waiting",
  onSort,
  ticketFor = () => undefined,
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
  grouping?: Grouping;
  onGrouping?: (g: Grouping) => void;
  sort?: SortMode;
  onSort?: (s: SortMode) => void;
  ticketFor?: (pr: ReviewPr) => TicketRef | undefined;
  /** Opens the merge-queue panel; when omitted the button is hidden (tests). */
  onOpenMergeQueue?: () => void;
  mergeQueueActive?: boolean;
  mergeQueueCount?: number;
  /** True when the viewer has a PR in the queue — nudges the button to accent. */
  mergeQueueHasMine?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  // Which PRs were requested of the viewer *directly* — the signal the category
  // sections encode structurally, and that the flat groupings would otherwise lose.
  const directIds = new Set((inbox?.requested ?? []).map((p) => p.id));

  return (
    <>
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <span className="text-[12px] font-semibold text-fg-2">Reviews</span>
        <span className="rounded-[5px] border border-line-2 bg-input-alt px-1.5 py-px font-mono text-[10.5px] text-muted-2">
          {total}
        </span>
      </div>

      {onGrouping && onSort && (
        <div className="flex flex-none items-center gap-1 border-b border-hairline px-2 py-1.5">
          <RailSelect
            value={grouping}
            onChange={(v) => onGrouping(v as Grouping)}
            title="How to group the pull requests"
          >
            <option value="category">Category</option>
            <option value="project">Project</option>
            <option value="repo">Repo</option>
          </RailSelect>
          <RailSelect
            value={sort}
            onChange={(v) => onSort(v as SortMode)}
            title="How to order the pull requests"
          >
            <option value="waiting">Waiting longest</option>
            <option value="updated">Recently updated</option>
            <option value="size">Smallest first</option>
          </RailSelect>
        </div>
      )}

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

        {inbox &&
          (grouping === "category" ? (
            <CategorySections
              inbox={inbox}
              sort={sort}
              activeId={activeId}
              onSelect={onSelect}
              ticketFor={ticketFor}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ) : (
            <FlatSections
              inbox={inbox}
              grouping={grouping}
              sort={sort}
              ticketFor={ticketFor}
              directIds={directIds}
              activeId={activeId}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))}
      </div>
    </>
  );
}

/** The default cut: my PRs, direct requests, teams, then completed requests. */
function CategorySections({
  inbox,
  sort,
  activeId,
  onSelect,
  ticketFor,
  collapsed,
  onToggle,
}: {
  inbox: ReviewInbox;
  sort: SortMode;
  activeId: string | null;
  onSelect: (id: string) => void;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { waiting, reviewed } = splitByStance(sortPrs(inbox.requested, sort));

  // GitHub can report the same PR as both a direct request and through one or
  // more teams. Category headings express priority, so render it only in the
  // first applicable section: direct before the ordered team list.
  const categorized = new Set(inbox.requested.map((pr) => pr.id));
  const uniqueTeams = inbox.teams.map((team) => ({
    ...team,
    prs: team.prs.filter((pr) => {
      if (categorized.has(pr.id)) return false;
      categorized.add(pr.id);
      return true;
    }),
  }));

  return (
    <>
      {inbox.mine.length > 0 && (
        <FoldingSection
          title="My PRs"
          count={inbox.mine.length}
          open={!collapsed.has(MINE_KEY)}
          onToggle={() => onToggle(MINE_KEY)}
        >
          <ProjectSections
            scope="mine"
            prs={inbox.mine}
            sort={sort}
            ticketFor={ticketFor}
            activeId={activeId}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        </FoldingSection>
      )}

      {waiting.length > 0 && (
        <FoldingSection
          title="Needs your review"
          count={waiting.length}
          open={!collapsed.has(REQUESTED_KEY)}
          onToggle={() => onToggle(REQUESTED_KEY)}
        >
          <ProjectSections
            scope="requested"
            prs={waiting}
            sort={sort}
            ticketFor={ticketFor}
            activeId={activeId}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        </FoldingSection>
      )}

      {uniqueTeams.map((team) => (
        <TeamSection
          key={team.slug}
          team={team}
          sort={sort}
          open={!collapsed.has(team.slug)}
          onToggle={() => onToggle(team.slug)}
          activeId={activeId}
          onSelect={onSelect}
          ticketFor={ticketFor}
          collapsed={collapsed}
          onProjectToggle={onToggle}
        />
      ))}

      {reviewed.length > 0 && (
        <FoldingSection
          title="Reviewed, waiting on author"
          count={reviewed.length}
          open={!collapsed.has(REVIEWED_KEY)}
          onToggle={() => onToggle(REVIEWED_KEY)}
        >
          <ProjectSections
            scope="reviewed"
            prs={reviewed}
            sort={sort}
            ticketFor={ticketFor}
            activeId={activeId}
            onSelect={onSelect}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        </FoldingSection>
      )}
    </>
  );
}

/** The project / repo cuts: one flat list, re-bucketed. Your own PRs are folded in
 *  too — under these groupings "mine" isn't the axis, the project or repo is. */
function FlatSections({
  inbox,
  grouping,
  sort,
  ticketFor,
  directIds,
  activeId,
  onSelect,
  collapsed,
  onToggle,
}: {
  inbox: ReviewInbox;
  grouping: Exclude<Grouping, "category">;
  sort: SortMode;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  directIds: Set<string>;
  activeId: string | null;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const all = [...inbox.requested, ...inbox.teams.flatMap((t) => t.prs), ...inbox.mine];
  // One PR can be both a team request and a direct one; keep the first sighting so
  // it doesn't render twice under the same heading.
  const seen = new Set<string>();
  const unique = all.filter((pr) => !seen.has(pr.id) && seen.add(pr.id));

  return (
    <>
      {groupPrs(unique, grouping, sort, ticketFor).map((group) => (
        <FoldingSection
          key={group.key}
          title={group.label}
          count={group.prs.length}
          open={!collapsed.has(`flat:${grouping}:${group.key}`)}
          onToggle={() => onToggle(`flat:${grouping}:${group.key}`)}
          glyph={
            grouping === "project" ? (
              <ProjectGlyph color={group.color ?? PROJECT_FALLBACK} icon={group.icon} />
            ) : undefined
          }
          meta={grouping === "project" ? <ProjectDueDate date={group.targetDate} /> : undefined}
        >
          {grouping === "project" ? (
            <MilestoneSections
              scope={`flat:project:${group.key}`}
              prs={group.prs}
              ticketFor={ticketFor}
              activeId={activeId}
              onSelect={onSelect}
              showRepo
              directIds={directIds}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ) : (
            <StackedRows
              prs={group.prs}
              ticketFor={ticketFor}
              activeId={activeId}
              onSelect={onSelect}
              directIds={directIds}
            />
          )}
        </FoldingSection>
      ))}
    </>
  );
}

/** The compact selects in the sidebar header. */
function RailSelect({
  value,
  onChange,
  title,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <ChevronSelect
      value={value}
      onChange={onChange}
      title={title}
      aria-label={title}
      wrapperClassName="min-w-0 flex-1"
      className="w-full rounded-[6px] border border-line-2 bg-input py-1 pr-6 pl-2 text-[11px] text-fg-2 hover:border-line-strong focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
    >
      {children}
    </ChevronSelect>
  );
}

/** A section that folds away. Rows are plain buttons (no effects), so conditional
 *  rendering on collapse is safe. */
function FoldingSection({
  title,
  count,
  open,
  onToggle,
  glyph,
  meta,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  glyph?: React.ReactNode;
  meta?: React.ReactNode;
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
        {glyph}
        <span className="truncate">{title}</span>
        {meta}
        <span
          className={
            meta
              ? "font-mono text-[10px] font-normal text-muted-4"
              : "ml-auto font-mono text-[10px] font-normal text-muted-4"
          }
        >
          {count}
        </span>
      </button>
      {open && children}
    </div>
  );
}

/** Responsibility remains the top-level inbox axis; within it, Linear projects
 *  make a long queue scannable without losing why each PR is present. */
function ProjectSections({
  scope,
  prs,
  sort,
  ticketFor,
  activeId,
  onSelect,
  collapsed,
  onToggle,
}: {
  scope: string;
  prs: ReviewPr[];
  sort: SortMode;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  activeId: string | null;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  return groupPrs(prs, "project", sort, ticketFor).map((group) => {
    const key = `category-project:${scope}:${group.key}`;
    const open = !collapsed.has(key);
    const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
    const showRepo = new Set(group.prs.map((pr) => pr.repo)).size > 1;
    return (
      <div key={group.key} className="mb-2">
        <button
          type="button"
          onClick={() => onToggle(key)}
          aria-expanded={open}
          className="mb-1 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-left font-mono text-[9.5px] tracking-[.05em] text-muted-3 uppercase transition-colors hover:bg-hover hover:text-fg-2"
        >
          <Chevron size={9} className="flex-none text-muted-4" />
          <ProjectGlyph color={group.color ?? PROJECT_FALLBACK} icon={group.icon} size={5} />
          <span className="truncate">{group.label}</span>
          <ProjectDueDate date={group.targetDate} />
          <span className="font-normal text-muted-4">{group.prs.length}</span>
        </button>
        {open && (
          <MilestoneSections
            scope={key}
            prs={group.prs}
            ticketFor={ticketFor}
            activeId={activeId}
            onSelect={onSelect}
            showRepo={showRepo}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        )}
      </div>
    );
  });
}

/** A per-team block: unlike a direct request, a team request isn't necessarily for
 *  the viewer to act on, so it folds — and the ones the viewer already reviewed are
 *  dropped rather than shown, since the block is low-signal to begin with. */
function TeamSection({
  team,
  sort,
  open,
  onToggle,
  activeId,
  onSelect,
  ticketFor,
  collapsed,
  onProjectToggle,
}: {
  team: TeamReviews;
  sort: SortMode;
  open: boolean;
  onToggle: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  collapsed: Set<string>;
  onProjectToggle: (key: string) => void;
}) {
  const { waiting } = splitByStance(sortPrs(team.prs, sort));
  if (waiting.length === 0) return null;
  return (
    <FoldingSection
      title={`Team · ${team.name}`}
      count={waiting.length}
      open={open}
      onToggle={onToggle}
    >
      <ProjectSections
        scope={`team:${team.slug}`}
        prs={waiting}
        sort={sort}
        ticketFor={ticketFor}
        activeId={activeId}
        onSelect={onSelect}
        collapsed={collapsed}
        onToggle={onProjectToggle}
      />
    </FoldingSection>
  );
}

const PR_STACK_INDENT = 12;

function StackConnector({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span
      aria-hidden
      className="relative flex flex-none self-stretch"
      style={{ width: depth * PR_STACK_INDENT }}
    >
      {Array.from({ length: depth }, (_, i) => {
        const own = i === depth - 1;
        return (
          <span key={i} className="relative" style={{ width: PR_STACK_INDENT }}>
            <span
              className="absolute top-0 left-0 border-line-2 border-l"
              style={{ height: own ? "50%" : "100%" }}
            />
            {own && (
              <span
                className="absolute top-1/2 left-0 border-line-2 border-t"
                style={{ width: PR_STACK_INDENT }}
              />
            )}
          </span>
        );
      })}
    </span>
  );
}

function MilestoneSections({
  scope,
  prs,
  ticketFor,
  activeId,
  onSelect,
  showRepo,
  directIds,
  collapsed,
  onToggle,
}: {
  scope: string;
  prs: ReviewPr[];
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  activeId: string | null;
  onSelect: (id: string) => void;
  showRepo: boolean;
  directIds?: Set<string>;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}) {
  const milestones = groupPrsByMilestone(prs, ticketFor);
  if (!showMilestoneGroups(milestones)) {
    return (
      <StackedRows
        prs={milestones[0]?.prs ?? []}
        ticketFor={ticketFor}
        activeId={activeId}
        onSelect={onSelect}
        showRepo={showRepo}
        directIds={directIds}
      />
    );
  }
  return milestones.map((milestone) => {
    const key = `milestone:${scope}:${milestone.key}`;
    const open = !collapsed.has(key);
    return (
      <div key={milestone.key} className="mb-2">
        <MilestoneHeading
          label={milestone.label}
          count={milestone.prs.length}
          targetDate={milestone.targetDate}
          open={open}
          onToggle={() => onToggle(key)}
        />
        {open && (
          <StackedRows
            prs={milestone.prs}
            ticketFor={ticketFor}
            activeId={activeId}
            onSelect={onSelect}
            showRepo={showRepo}
            directIds={directIds}
          />
        )}
      </div>
    );
  });
}

function StackedRows({
  prs,
  ticketFor,
  activeId,
  onSelect,
  showRepo = false,
  directIds,
}: {
  prs: ReviewPr[];
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  activeId: string | null;
  onSelect: (id: string) => void;
  showRepo?: boolean;
  directIds?: Set<string>;
}) {
  return stackPrs(prs).map(({ pr, depth }) => (
    <div key={pr.id} className="flex" data-pr-id={pr.id} data-stack-depth={depth}>
      <StackConnector depth={depth} />
      <div className="min-w-0 flex-1">
        <PrRow
          pr={pr}
          active={pr.id === activeId}
          onSelect={onSelect}
          showRepo={showRepo}
          direct={directIds?.has(pr.id)}
          ticket={ticketFor(pr)}
        />
      </div>
    </div>
  ));
}

function PrRow({
  pr,
  active,
  onSelect,
  showRepo = false,
  direct = false,
  ticket,
}: {
  pr: ReviewPr;
  active: boolean;
  onSelect: (id: string) => void;
  showRepo?: boolean;
  /** Requested of the viewer personally. Only rendered under the flat groupings,
   *  where the section heading no longer says so. */
  direct?: boolean;
  ticket?: TicketRef;
}) {
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];
  const days = waitingDays(pr);
  const priority = ticket?.priority ?? "None";

  return (
    <button
      type="button"
      onClick={() => onSelect(pr.id)}
      className="entity-card mb-[5px] flex w-full cursor-pointer flex-col gap-[5px] px-[11px] py-2 text-left transition-colors"
      data-active={active}
    >
      <div className="flex items-center gap-1.5">
        <Dot color={decision.color} size={6} />
        <span className="font-mono text-[10.5px] text-muted-2">#{pr.number}</span>
        {priority !== "None" && <PriorityBars priority={priority} />}
        {direct && (
          <span
            className="rounded-[4px] px-1 font-mono text-[8.5px] uppercase"
            style={{ color: "var(--accent)", border: `1px solid ${alpha(40)}` }}
            title="Your review was requested personally"
          >
            @you
          </span>
        )}
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
        <span className="ml-auto" style={{ color: checks.color }} title={checks.label}>
          <CheckStateIcon state={pr.checks} />
        </span>
      </div>
      <MarkdownTitle
        className="overflow-hidden text-[12px] leading-[1.3] text-ellipsis whitespace-nowrap"
        style={{ color: active ? "var(--accent)" : "var(--color-fg-2)" }}
      >
        {pr.title}
      </MarkdownTitle>
      <div className="flex items-center gap-2 font-mono text-[10px] text-muted-4">
        <span
          style={{ color: reviewAgeColor(days) }}
          title={`Waiting since ${new Date(pr.waitingSince).toLocaleString()}`}
        >
          {waitingLabel(days)}
        </span>
        {showRepo && <span className="truncate">{repoName(pr.repo)}</span>}
        <span className="ml-auto flex items-center gap-2">
          <ChangeSizeBars
            additions={pr.additions}
            deletions={pr.deletions}
            files={pr.changedFiles}
            noun="review"
          />
          {pr.aiDraftCount > 0 && (
            <span
              className="flex items-center gap-1"
              style={{ color: palette.purple }}
              title={`${pr.aiDraftCount} AI draft comment${pr.aiDraftCount === 1 ? "" : "s"}`}
            >
              <SparklesIcon size={10} />
              <span className="tabular-nums">{pr.aiDraftCount}</span>
            </span>
          )}
          {pr.commentCount > 0 && (
            <span
              className="flex items-center gap-1 text-muted-3"
              title={`${pr.commentCount} comments`}
            >
              <MessageSquareIcon size={10} />
              <span className="tabular-nums">{pr.commentCount}</span>
            </span>
          )}
        </span>
      </div>
    </button>
  );
}

function CheckStateIcon({ state }: { state: ReviewPr["checks"] }) {
  if (state === "Success") return <CheckIcon size={10} />;
  if (state === "Failure") return <CloseIcon size={10} />;
  if (state === "Pending") return <ClockIcon size={10} />;
  return <span className="block h-2.5 w-2.5" />;
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
