/**
 * A project's review inbox, as a folding section of the sidebar tree.
 *
 * It sits between the project header and the repo's own checkout because that is
 * where it belongs in the reading order: a project's *incoming* work, above the
 * work already on disk.
 *
 * **It is a band, not a destination.** Pressing the heading folds it — it opens
 * nothing — so it wears `.tree-band` like the project and milestone headings and
 * takes no selection fill (see the register comment in `styles.css`). The rows
 * inside it are the destinations, and they are cards like every other piece of
 * work in this rail.
 *
 * **One block per asker, in the order you'd triage them**: what is asked of you
 * personally, then one block per team that asked. `reviewGroupsByProject` builds
 * them (`lib/queries.ts`), beside the counts and over the same rule, so the
 * number on the folded heading can't disagree with the rows under the open one.
 * Above them sits the repo's merge queue, when it has one at all
 * ({@link MergeQueueRow}) — the section's one row that is a place rather than a
 * pull request. Your own PRs are not here: a PR you opened is worked on beside
 * its worktree, which already has a row in this rail (CLAUDE.md, "Trees is the
 * workspace; Reviews is the inbox").
 *
 * **The number is what still needs you**: it comes off `awaitingReviewPrs`, the
 * app's one definition of that, and the blocks sum to it. It only shows while
 * the section is folded — open, each block carries its own count and a total
 * above them would only restate the sum. A PR you already reviewed drops out
 * until its author pushes again, which is why this section can go quiet without
 * anything merging.
 *
 * **Zero renders nothing** (see {@link showReviewsSection}): a quiet project is
 * visually silent, not a column of noughts. The one thing louder than a zero is
 * an unanswerable question, so a `gh` that isn't signed in still gets a heading —
 * with no number at all, because "we couldn't ask" and "nothing is waiting" are
 * different facts and only one of them is a count.
 */
import { type ReactNode, useState } from "react";

import type { ReviewPr, TicketRef } from "../../bindings";
import { agentKey } from "../../features/agents/registry";
import { stackGuides, stackPrs } from "../../features/reviews/grouping";
import { ticketIdFor } from "../../features/reviews/ticket";
import { BULK_TOGGLE_HINT, isBulkToggle } from "../../lib/disclosure";
import {
  type LinearGroupBy,
  type ReviewGroup,
  type ReviewProjectCounts,
  useMergeQueue,
} from "../../lib/queries";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitHubLogo,
  LinearLogo,
  MergeQueueIcon,
  PrIcon,
} from "../icons";
import { MarkdownTitle } from "../Markdown";
import {
  BAND_LABEL_X,
  BandHeading,
  CARD_GLYPH,
  CARD_INSET,
  CARD_LABEL_X,
  groupByMilestone,
  groupByProject,
  INDENT_PX,
  MilestoneHeading,
  PROJECT_LABEL_X,
  ProjectHeading,
  StackConnector,
  showMilestoneGroups,
  showProjectGroups,
} from "../WorkSignals";
import { AgentRow } from "./AgentRow";
import { AgentSummaryRow } from "./AgentSummaryRow";
import { ReviewPrMenu } from "./ReviewPrMenu";
import type { AgentNode } from "./useProjectTree";

/**
 * The AI review sessions a pull request row hangs underneath it, and what a click
 * on one does — the same pair `WorktreeRow` gets, passed as one object because it
 * travels four levels of nesting to reach the row that draws it.
 *
 * Optional the whole way down: a rail rendered without it (the section's own
 * tests, and any host that has no agent registry to offer) draws plain PR rows.
 */
export interface PrAgents {
  listFor: (pr: ReviewPr) => AgentNode[];
  onOpen: (agent: AgentNode) => void;
}

/**
 * The ladder, in two moves.
 *
 * A heading's own children step in by {@link INDENT_PX}, the same step every
 * other level of this rail uses. **Rows** step in by their heading's label offset
 * instead ({@link BAND_LABEL_X} / {@link PROJECT_LABEL_X}), so a PR title lines up
 * with the words of the heading above it rather than with that heading's chevron
 * — which is what made a nested inbox read as one flat list.
 */
function rowsUnder(heading: number, labelX: number): number {
  return heading + labelX;
}

/** What the tree knows about one project's reviews. `null` while the inbox read
 *  is still in flight — an unknown is not a zero, so nothing renders yet. */
export interface ProjectReviews {
  counts: ReviewProjectCounts;
  /** `gh` had a token. Without one every count above is zero for a reason the
   *  number cannot state (see `ReviewInbox.githubConnected`). */
  connected: boolean;
  /** The blocks the open section draws — see `reviewGroupsByProject`. */
  groups: ReviewGroup[];
}

/**
 * Whether this project earns a Reviews section at all.
 *
 * Stated once, here, because two callers ask it: the section itself, and the
 * project header that has to carry the count while the whole project is folded.
 *
 * **A quiet project shows nothing, unless you ask it to.** The resting state is
 * silence; `REVIEWS_SHOW_EMPTY_KEY` turns every project with a GitHub remote into
 * a folded section and a nought instead, which is what makes the feature's
 * *absence* legible — one repo showing Reviews while the two beside it show
 * nothing otherwise reads as santree only knowing about the first.
 *
 * A project with no GitHub `origin` is still handled by the caller not building a
 * {@link ProjectReviews} for it — that one can never have reviews, however long
 * you wait, so it is silent forever rather than silent today.
 */
export function showReviewsSection(
  reviews: ProjectReviews | null,
  /** Draw the section even with nothing in it — see `REVIEWS_SHOW_EMPTY_KEY`. */
  showWhenEmpty: boolean,
): reviews is ProjectReviews {
  if (reviews === null) return false;
  // Not connected is not empty: every count is zero for a reason a zero cannot
  // state, so that section renders whatever the setting says.
  if (!reviews.connected) return true;
  // `groups` needs no clause of its own: every PR a block lists is one the count
  // counted, so a project with rows is a project with a nonzero total.
  return showWhenEmpty || reviews.counts.total > 0;
}

/**
 * Who is waiting, in words — the heading's hover and the tail of its accessible
 * name.
 *
 * Teams are org-qualified (`@acme/eng`) for the same reason the Reviews view's own
 * sections are: two orgs can have a team of the same name and they are different
 * people.
 */
export function reviewBreakdown(counts: ReviewProjectCounts): string {
  const parts: string[] = [];
  if (counts.direct > 0) parts.push(`${counts.direct} for you`);
  if (counts.team > 0) {
    // The teams are normally known; falling back to the count alone keeps a row
    // truthful rather than naming a team it can't name.
    const via = counts.teams.length
      ? counts.teams.map((team) => `@${team}`).join(", ")
      : "a team you're on";
    parts.push(`${counts.team} via ${via}`);
  }
  return parts.join(" · ");
}

/** The heading's full accessible name: which project, then who is waiting. Used
 *  as the `title` too, so the pointer and the screen reader are told the same
 *  thing — a breakdown only a hover can reach is a breakdown half the users
 *  never get. */
export function reviewsSectionLabel(project: string, reviews: ProjectReviews): string {
  if (!reviews.connected) return `${project} reviews — GitHub isn't connected`;
  const waiting = reviewBreakdown(reviews.counts);
  return waiting ? `${project} reviews — ${waiting}` : `${project} reviews`;
}

/**
 * The breakdown the project header offers on hover, or `null` when it has
 * nothing to add.
 *
 * The count on the header can't carry its own tooltip: it sits under the
 * header's stretched toggle, so it is `pointer-events-none` and a `title` on it
 * would never open. The header's own tooltip is where the words go instead — one
 * rule, {@link ProjectReviewsBadge} renders on the same one.
 */
export function headerReviewsHint(reviews: ProjectReviews | null): string | null {
  if (!reviews?.connected || reviews.counts.total === 0) return null;
  return `${reviewBreakdown(reviews.counts)} — reviews waiting on you`;
}

/** One count on a project header: a glyph, its number beside it, and the noun a
 *  screen reader needs — a bare number is not a fact. Not interactive (the
 *  header's stretched toggle is behind it), so the noun is `sr-only` rather than
 *  a label a pointer-less reader would never hear. The digits keep a reserved
 *  width, so a number that lands late or grows a digit never reflows the row. */
export function HeaderCount({
  icon,
  count,
  srLabel,
}: {
  icon: ReactNode;
  /** `null` while the read is still in flight: the slot stays, the claim doesn't. */
  count: number | null;
  srLabel: string;
}) {
  return (
    <span className="pointer-events-none flex flex-none items-center gap-1 font-mono text-[10px] text-fg-2 tabular-nums">
      <span className="flex flex-none text-muted-4">{icon}</span>
      <span className="min-w-[13px]">{count}</span>
      <span className="sr-only"> {srLabel}</span>
    </span>
  );
}

/** The reviews count on the project's own header, open or folded. Without it a
 *  rail is one you expand project by project to learn that nothing needs you;
 *  the ask was to read it at a glance instead. Silent at zero, like the section
 *  ({@link showReviewsSection}): a quiet project is not a nought. */
export function ProjectReviewsBadge({ reviews }: { reviews: ProjectReviews }) {
  if (!headerReviewsHint(reviews)) return null;
  return (
    <HeaderCount
      icon={<GitHubLogo size={9} />}
      count={reviews.counts.total}
      srLabel="reviews waiting on you"
    />
  );
}

/** One project's Reviews section: the folding heading and, open, its blocks.
 *
 *  `bandIndent` is the gutter of the section's own heading — the caller owns where
 *  the section starts, and everything below it steps from there. */
export function ProjectReviewsSection({
  project,
  repo,
  reviews,
  bandIndent,
  open,
  onToggle,
  isGroupOpen,
  onToggleGroup,
  onOpenPr,
  onOpenMergeQueue,
  openPrUrl = null,
  groupBy = "none",
  ticketFor = () => undefined,
  agents,
}: {
  /** The project's short label — what the accessible name calls it. */
  project: string;
  /** Its registry name — what the merge-queue read is keyed by. Distinct from
   *  {@link project} on purpose: one is what the row calls the project, the
   *  other is what santree calls it. */
  repo: string;
  reviews: ProjectReviews;
  bandIndent: number;
  open: boolean;
  onToggle: (bulk: boolean) => void;
  /** Whether one block is expanded, by its group key. */
  isGroupOpen: (key: string) => boolean;
  /** `bulk` is the ⌘-click — see `lib/disclosure`. */
  onToggleGroup: (key: string, bulk: boolean) => void;
  onOpenPr: (pr: ReviewPr) => void;
  /** Open the Reviews view on this project's merge queue — the one row here that
   *  is not a pull request. */
  onOpenMergeQueue: () => void;
  /** The pull request the Reviews view has open, by url. The rail carries one
   *  selection and it belongs to whichever destination is on screen, so this is
   *  `null` the moment you are looking at anything but Reviews. */
  openPrUrl?: string | null;
  /** How deep to nest inside each block, from the `github_group_by` setting.
   *  Defaults to the flat list, which is what an install that never opened
   *  Settings sees. */
  groupBy?: LinearGroupBy;
  /** The Linear ticket behind a PR — what the nesting groups on. Without it
   *  (no Linear org, read still in flight) every PR lands in the catch-all,
   *  which is why the caller gates the setting on this being answerable. */
  ticketFor?: (pr: ReviewPr) => TicketRef | undefined;
  /** The AI review sessions to hang under each PR row. Absent draws none. */
  agents?: PrAgents;
}) {
  const label = reviewsSectionLabel(project, reviews);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  // The blocks are the section heading's children, so they take a full indent
  // from it; everything under them steps from there (see `rowsUnder`).
  const blockGutter = bandIndent + INDENT_PX;
  return (
    <div>
      <div
        className="tree-band relative flex items-center gap-1.5 px-2 py-(--density-compact)"
        style={{ marginLeft: bandIndent, marginRight: CARD_INSET }}
      >
        <button
          type="button"
          onClick={(e) => onToggle(isBulkToggle(e))}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
          title={`${label}\n${BULK_TOGGLE_HINT}`}
          className="absolute inset-0 cursor-pointer"
        />
        <Chevron size={9} className="pointer-events-none flex-none text-muted-4" />
        <GitHubLogo size={11} className="pointer-events-none flex-none text-muted-4" />
        <span className="pointer-events-none min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-2">
          Reviews
        </span>
        {/* Folded, the number is the only thing left of the section, so it carries
            it. Open, each block below carries its own count and says more than a
            total can. */}
        {!open && reviews.connected && (
          <span className="pointer-events-none flex-none font-mono text-[10px] text-fg-2 tabular-nums">
            {reviews.counts.total}
          </span>
        )}
      </div>

      {open && <MergeQueueRow repo={repo} indent={blockGutter} onOpen={onOpenMergeQueue} />}

      {open &&
        reviews.groups.map((group) => {
          const groupOpen = isGroupOpen(group.key);
          return (
            <div key={group.key}>
              <div style={{ paddingLeft: blockGutter }}>
                <BandHeading
                  label={group.label}
                  count={group.prs.length}
                  open={groupOpen}
                  onToggle={(bulk) => onToggleGroup(group.key, bulk)}
                  noun="review group"
                  title={group.title ?? undefined}
                />
              </div>
              {groupOpen && (
                <PrList
                  prs={group.prs}
                  headingGutter={blockGutter}
                  groupBy={groupBy}
                  ticketFor={ticketFor}
                  keyPrefix={group.key}
                  isGroupOpen={isGroupOpen}
                  onToggleGroup={onToggleGroup}
                  onOpenPr={onOpenPr}
                  openPrUrl={openPrUrl}
                  agents={agents}
                />
              )}
            </div>
          );
        })}

      {/* Connected and quiet is a real answer and worth stating once, rather than
          leaving an expanded section that looks like it failed to load. */}
      {open && reviews.groups.length === 0 && (
        <div
          className="py-(--density-compact) text-[11px] text-muted-4"
          style={{ paddingLeft: rowsUnder(blockGutter, BAND_LABEL_X) }}
        >
          {reviews.connected ? "Nothing waiting on you" : "Sign in to GitHub to see reviews"}
        </div>
      )}
    </div>
  );
}

/**
 * The repo's merge queue, as a row inside its Reviews section.
 *
 * **Only when the repo has one.** `MergeQueueView` answers three different
 * questions in one shape — "we couldn't ask", "this repo has no queue" and "the
 * queue is empty" — and only the last of them is a row: a zero there is a real
 * fact about a real queue, while a row on a repo whose default branch has no
 * queue enabled would invent a feature that repo doesn't have. The first two are
 * silence for the same reason the section's own count is silent when `gh` can't
 * be asked.
 *
 * It sits above the blocks because it isn't one of them: those are pull requests
 * grouped by who asked for the review, and this is the one row here that is a
 * place rather than a piece of work. A destination, so it takes the row register
 * (`.tree-row`, which fills on hover) rather than the band heading's.
 */
function MergeQueueRow({
  repo,
  indent,
  onOpen,
}: {
  repo: string;
  indent: number;
  onOpen: () => void;
}) {
  const { data: view } = useMergeQueue(repo);
  const queue = view?.queue;
  if (!queue) return null;
  const count = queue.entries.length;
  return (
    <div style={{ paddingLeft: indent, paddingRight: CARD_INSET }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open the merge queue — ${count} pull request${count === 1 ? "" : "s"} waiting`}
        title={`Merge queue → ${queue.branch}`}
        className="tree-row flex w-full cursor-pointer items-center gap-1.5 px-2 py-(--density-compact) text-left"
      >
        <MergeQueueIcon size={11} className="flex-none text-muted-4" />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-muted-2">
          Merge queue
        </span>
        <span className="flex-none font-mono text-[10px] text-fg-2 tabular-nums">{count}</span>
      </button>
    </div>
  );
}

/**
 * The rows under one block, nested by the `github_group_by` setting.
 *
 * **A level that isn't drawn costs nothing.** `showProjectGroups` and
 * `showMilestoneGroups` suppress a heading that would only restate the block it
 * sits in (one project, or one "No milestone" bucket), and a suppressed heading
 * hands its rows the gutter it would have used — so a review inbox that happens
 * to be one project deep still reads as the flat list it effectively is. Same
 * rule the sidebar's worktree tree follows one level up.
 *
 * The step is the heading's own `px-2` rather than a full {@link INDENT_PX},
 * because these are the *inner* levels: the rail is a few hundred pixels wide and
 * a full step per level would spend the PR title, which is the only string here
 * you actually read.
 */
function PrList({
  prs,
  headingGutter,
  labelX = BAND_LABEL_X,
  groupBy,
  ticketFor,
  keyPrefix,
  isGroupOpen,
  onToggleGroup,
  onOpenPr,
  openPrUrl,
  agents,
}: {
  prs: ReviewPr[];
  /** Where the heading *above* this level sits. Rows hang from its label; a
   *  heading this level draws steps one full indent in from it. */
  headingGutter: number;
  /** That heading's label offset — `ProjectHeading` carries a glyph, so its words
   *  start further in than a `BandHeading`'s do. */
  labelX?: number;
  groupBy: LinearGroupBy;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  /** Namespaces the persisted folds, or two blocks' "Platform" bands share one. */
  keyPrefix: string;
  isGroupOpen: (key: string) => boolean;
  /** `bulk` is the ⌘-click — see `lib/disclosure`. */
  onToggleGroup: (key: string, bulk: boolean) => void;
  onOpenPr: (pr: ReviewPr) => void;
  openPrUrl: string | null;
  agents?: PrAgents;
}) {
  const byProject = groupBy === "project" || groupBy === "project_milestone";
  const milestones = (
    prs: ReviewPr[],
    heading: number,
    parentLabelX: number,
    keyPrefix: string,
  ) => (
    <MilestoneList
      prs={prs}
      headingGutter={heading}
      labelX={parentLabelX}
      enabled={groupBy === "milestone" || groupBy === "project_milestone"}
      ticketFor={ticketFor}
      keyPrefix={keyPrefix}
      isGroupOpen={isGroupOpen}
      onToggleGroup={onToggleGroup}
      onOpenPr={onOpenPr}
      openPrUrl={openPrUrl}
      agents={agents}
    />
  );
  if (!byProject) return milestones(prs, headingGutter, labelX, keyPrefix);

  const bands = groupByProject(prs, (pr) => projectRefOf(ticketFor(pr)));
  // One band is the block restated. Its rows stay where they would have been, so
  // a suppressed heading costs them nothing.
  if (!showProjectGroups(bands))
    return milestones(bands[0]?.items ?? prs, headingGutter, labelX, keyPrefix);

  const gutter = headingGutter + INDENT_PX;
  return (
    <>
      {bands.map((band) => {
        const key = `${keyPrefix}:proj:${band.key}`;
        const open = isGroupOpen(key);
        return (
          <div key={band.key}>
            <div style={{ paddingLeft: gutter }}>
              <ProjectHeading
                label={band.label}
                count={band.items.length}
                color={band.color}
                icon={band.icon}
                targetDate={band.targetDate}
                open={open}
                onToggle={(bulk) => onToggleGroup(key, bulk)}
              />
            </div>
            {open && milestones(band.items, gutter, PROJECT_LABEL_X, key)}
          </div>
        );
      })}
    </>
  );
}

/** The milestone level, and the rows themselves. Same suppression rule as the
 *  project level above it: a lone "No milestone" bucket draws no heading, and its
 *  rows stay hanging from whatever heading is actually above them. */
function MilestoneList({
  prs,
  headingGutter,
  labelX,
  enabled,
  ticketFor,
  keyPrefix,
  isGroupOpen,
  onToggleGroup,
  onOpenPr,
  openPrUrl,
  agents,
}: {
  prs: ReviewPr[];
  headingGutter: number;
  labelX: number;
  enabled: boolean;
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  keyPrefix: string;
  isGroupOpen: (key: string) => boolean;
  /** `bulk` is the ⌘-click — see `lib/disclosure`. */
  onToggleGroup: (key: string, bulk: boolean) => void;
  onOpenPr: (pr: ReviewPr) => void;
  openPrUrl: string | null;
  agents?: PrAgents;
}) {
  const rows = (list: ReviewPr[], at: number) => (
    <StackedRows prs={list} indent={at} onOpen={onOpenPr} openPrUrl={openPrUrl} agents={agents} />
  );
  if (!enabled) return rows(prs, rowsUnder(headingGutter, labelX));

  const groups = groupByMilestone(prs, (pr) => ticketFor(pr)?.projectMilestone);
  if (!showMilestoneGroups(groups))
    return rows(groups[0]?.items ?? prs, rowsUnder(headingGutter, labelX));

  const gutter = headingGutter + INDENT_PX;
  return (
    <>
      {groups.map((group) => {
        const key = `${keyPrefix}:ms:${group.key}`;
        const open = isGroupOpen(key);
        return (
          <div key={group.key}>
            <div style={{ paddingLeft: gutter }}>
              <MilestoneHeading
                label={group.label}
                count={group.items.length}
                targetDate={group.targetDate}
                open={open}
                onToggle={(bulk) => onToggleGroup(key, bulk)}
              />
            </div>
            {open && rows(group.items, rowsUnder(gutter, BAND_LABEL_X))}
          </div>
        );
      })}
    </>
  );
}

/** The Linear project a PR's ticket belongs to, in the shape the shared grouper
 *  wants. A PR with no ticket (or whose ticket Linear didn't return) lands in the
 *  catch-all band rather than being dropped. */
function projectRefOf(ticket: TicketRef | undefined) {
  if (!ticket) return null;
  return {
    name: ticket.project,
    color: ticket.projectColor,
    icon: ticket.projectIcon,
    targetDate: ticket.projectTargetDate,
  };
}

/**
 * The leaf list: a PR whose branch came off another PR's branch sits under it.
 *
 * Indentation alone reads as an accident at this depth, so each child also draws
 * the elbow a file tree draws (see {@link StackConnector}) — that is what makes
 * "this one is stacked on that one" legible without a legend. `stackPrs` matches
 * on GitHub's ref node ids rather than branch names, so two forks that both have
 * a `main` never link.
 */
function StackedRows({
  prs,
  indent,
  onOpen,
  openPrUrl,
  agents,
}: {
  prs: ReviewPr[];
  indent: number;
  onOpen: (pr: ReviewPr) => void;
  openPrUrl: string | null;
  agents?: PrAgents;
}) {
  const stacked = stackPrs(prs);
  // Which rules each row's connector draws — a property of the rows *around* it,
  // so it is computed once for the list rather than guessed per row.
  const guides = stackGuides(stacked);
  return (
    <>
      {stacked.map(({ pr, depth }, i) => (
        <ReviewPrRow
          key={pr.id}
          pr={pr}
          indent={indent}
          depth={depth}
          guides={guides[i]}
          active={pr.url === openPrUrl}
          onOpen={() => onOpen(pr)}
          agents={agents}
        />
      ))}
    </>
  );
}

/**
 * One pull request, as a card in the rail.
 *
 * The same card the worktrees below it use, for the same reason: this is a piece
 * of work you pick, not a line of chrome. It carries the Linear mark when the PR
 * names a ticket and **no GitHub mark at all** — the row itself opens the pull
 * request, so a mark for it would be a second button to the place you already are.
 *
 * Nothing here is a status: how a PR is doing (checks, draft, decision) is what
 * the Reviews view is for, and a rail that tried to say it would spend its width
 * on five glyphs and leave the title truncated to a verb.
 *
 * **Line two is the AI review sessions**, exactly as a worktree card carries the
 * agents running in it — one row each, or a fold once there are several. A review
 * is work with an agent on it, and the rail says so in one vocabulary rather than
 * making a PR the one card whose agents are invisible until you open it.
 *
 * A right-click is the rest of what the row knows ({@link ReviewPrMenu}): the
 * PR on GitHub, its number, link, branch and ticket, and its checkout when it
 * has one.
 */
function ReviewPrRow({
  pr,
  indent,
  depth,
  guides,
  active,
  onOpen,
  agents,
}: {
  pr: ReviewPr;
  indent: number;
  /** How far down a stack this PR sits — the width of its connector. */
  depth: number;
  /** Which of its columns are still live below it (see `stackGuides`). */
  guides: boolean[];
  /** This is the pull request the Reviews view has open — the rail's one lit row. */
  active: boolean;
  onOpen: () => void;
  agents?: PrAgents;
}) {
  const ticket = ticketIdFor(pr);
  const sessions = agents?.listFor(pr) ?? [];
  // Local, not persisted — the same "let me look" gesture a worktree card's fold
  // is, and a rail that reopened yesterday's expansions on launch is noisier.
  const [expanded, setExpanded] = useState(false);
  // Everything the row can't spare a column for lives here, the way `WorktreeRow`
  // keeps its branch name one hover away. The base branch earns a line only on a
  // stacked PR, where "what did this come off" is the question the elbow raises.
  const title = [
    pr.title,
    `${pr.repo}#${pr.number}`,
    depth > 0 ? `Stacked on ${pr.baseRef}` : null,
    ticket ? `Linear · ${ticket}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    // The connector is drawn in the gutter, beside the card rather than inside
    // it, so the card's own highlight still starts at the row's text.
    <div className="flex" style={{ paddingLeft: indent - CARD_INSET }}>
      <StackConnector guides={guides} />
      <ReviewPrMenu pr={pr}>
        <div
          className="tree-card relative min-w-0 flex-1"
          data-active={active}
          style={{ marginRight: CARD_INSET }}
        >
          <div
            className="relative flex items-center gap-1.5 py-(--density-standard) pr-1.5"
            style={{ paddingLeft: CARD_INSET }}
          >
            <button
              type="button"
              onClick={onOpen}
              aria-label={`Open ${pr.title}`}
              title={title}
              className="absolute inset-0 cursor-pointer"
            />
            {/* Leads the line, the way the branch glyph leads a worktree's: read
              left to right, the glyph says what kind of thing this row is before
              the title lands. Always the open-PR mark: the inbox is searched
              `is:open`, so nothing merged or closed reaches this rail. Decorative
              — the row's tooltip names the PR in full. */}
            <span aria-hidden className="flex flex-none items-center text-muted-3">
              <PrIcon size={CARD_GLYPH} />
            </span>
            <MarkdownTitle className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-fg-2">
              {pr.title}
            </MarkdownTitle>
            {/* Decorative: it says "this one has a ticket", and which ticket is in
              the row's own tooltip — under the stretched action a tooltip of its
              own would never open. */}
            {ticket && (
              <span aria-hidden className="flex flex-none items-center text-muted-4">
                <LinearLogo size={11} />
              </span>
            )}
          </div>

          {sessions.length === 1 && (
            <AgentRow
              node={sessions[0]}
              indent={CARD_LABEL_X}
              onOpen={() => agents?.onOpen(sessions[0])}
            />
          )}
          {sessions.length > 1 && (
            <AgentSummaryRow
              agents={sessions}
              expanded={expanded}
              onToggle={() => setExpanded((open) => !open)}
              indent={CARD_LABEL_X}
            />
          )}
          {sessions.length > 1 &&
            expanded &&
            sessions.map((agent) => (
              <AgentRow
                key={agentKey(agent.entry)}
                node={agent}
                indent={CARD_LABEL_X + INDENT_PX}
                onOpen={() => agents?.onOpen(agent)}
              />
            ))}
          {/* The card's own bottom padding, so the last session isn't flush with
            the highlight's edge. Zero when there is nothing under the title. */}
          {sessions.length > 0 && <div className="h-1" />}
        </div>
      </ReviewPrMenu>
    </div>
  );
}
