/**
 * The right panel's AI work pane: everything on this pull request that still
 * needs doing, and the AI's reading of the PR that most of it comes from.
 *
 * These were two tabs, and the split cost more than it bought. You read the
 * brief to decide what to fix, and the queue is where a fix goes — so the reader
 * paid a tab switch (and their place in the reading order) on every single item,
 * and the "add a note" box had to be duplicated into the brief to make that
 * bearable. One pane, one destination: a failing check, a reviewer's comment, an
 * AI draft, a highlighted diff line and a note you type all land in the same
 * list, and "Start work" hands the open ones to a single agent session in the
 * main area.
 *
 * **Queue first, brief second** — the same order Reviews composes the same two
 * components in ({@link PrInfoPanel}). The queue is what you come back to; the
 * brief is what you read once.
 *
 * The body is {@link ReviewWorklist} and {@link ReviewBriefSection}, the same two
 * components the Reviews tab renders, given this host's callbacks. Two things
 * differ. The jump: Reviews scrolls its diff column, and here a file opens in the
 * **main** area, deliberately leaving this tab where it is — reading the code is
 * what the reading order is *for*, and a click that swapped the panel to
 * something else would cost the reader their place after every file. And the
 * launch: the PR's worktree already exists here, so both "Start work" and "Start
 * review" skip creating one.
 *
 * The queue half is not PR-specific — a note is just a note — but the backend's
 * `review_work_items` rows are keyed `(pr_repo, pr_number)` with
 * `CHECK (pr_number > 0)`, so there is nowhere to put a PR-less item yet. Hence
 * the `WorktreePr | null` prop and the empty state below: the day a migration
 * lifts that key, making this pane always-available is one line in
 * `availableFileTabs` plus a PR-less queue here, not a rewrite.
 */
import type { ReviewPr, WorktreePr } from "../../bindings";
import { EmptyState, Skeleton } from "../../components/primitives";
import { usePrDetail, usePrSummary, useReviewDrafts } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { ReviewBriefSection } from "../reviews/ReviewBriefSection";
import { ReviewWorklist } from "../reviews/ReviewWorklist";
import { useStartAiReviewInWorktree, useStartWorkInWorktree } from "../reviews/useStartWork";
import { useTrees } from "./model";

export function WorktreeAiWorkPane({ pr }: { pr: WorktreePr | null }) {
  const { data: summary } = usePrSummary(pr?.repo ?? "", pr?.number ?? 0);

  if (!pr) {
    return (
      <EmptyState
        title="No pull request yet"
        subtitle="The queue and the AI's review of the branch live here once it has one."
      />
    );
  }
  if (!summary) {
    return (
      <div className="space-y-2 px-3 py-3">
        <Skeleton className="h-7 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="mt-3 h-20 w-full rounded-md" />
      </div>
    );
  }
  return <Loaded pr={summary} />;
}

function Loaded({ pr }: { pr: ReviewPr }) {
  const { repo, activeId, selectFile } = useTrees();
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { data: drafts = [] } = useReviewDrafts(pr.repo, pr.number);
  const startWork = useStartWorkInWorktree(pr, activeId, repo);
  const startReview = useStartAiReviewInWorktree(pr, activeId, repo);
  const jump = (path: string) => selectFile(path, "branch");

  if (!activeId) {
    return <EmptyState title="No workspace selected" />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <ReviewWorklist
        pr={pr}
        detail={detail}
        drafts={drafts}
        onFocusFile={jump}
        onStartWork={startWork}
      />
      <ReviewBriefSection
        pr={pr}
        activeReviewAgent={null}
        santreeRepo={repo}
        onJump={jump}
        onStartReview={startReview}
        // The launcher takes a per-launch agent override, so the picker beside
        // the run button is live here (it is not in Reviews — see the prop).
        canPickAgent
      />
    </div>
  );
}
