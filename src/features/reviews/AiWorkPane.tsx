/**
 * The side panel's AI work pane: everything on this pull request that still
 * needs doing, and the AI's reading of the PR that most of it comes from.
 *
 * These were two tabs, and the split cost more than it bought. You read the
 * brief to decide what to fix, and the queue is where a fix goes — so the reader
 * paid a tab switch (and their place in the reading order) on every single item,
 * and the "add a note" box had to be duplicated into the brief to make that
 * bearable. One pane, one destination: a failing check, a reviewer's comment, an
 * AI draft, a highlighted diff line and a note you type all land in the same
 * list, and "Start work" hands the open ones to a single agent session.
 *
 * **Queue first, brief second.** The queue is what you come back to; the brief is
 * what you read once.
 *
 * The body is {@link ReviewWorklist} and {@link ReviewBriefSection}. Both hosts —
 * the worktree's panel in Trees and the PR's rail in Reviews — render the same
 * one, and the two things that genuinely differ between them are props. The jump:
 * Reviews scrolls its own diff column, Trees opens the file in the **main** area,
 * deliberately leaving this tab where it is (reading the code is what the reading
 * order is *for*, and a click that swapped the panel would cost the reader their
 * place after every file). And the launch: the PR's worktree already exists in
 * Trees, so its "Start work" skips creating one, where Reviews' cuts a checkout
 * first — see `useStartWork.ts`, which is where that difference actually lives.
 *
 * The queue half is not PR-specific — a note is just a note — but the backend's
 * `review_work_items` rows are keyed `(pr_repo, pr_number)` with
 * `CHECK (pr_number > 0)`, so there is nowhere to put a PR-less item yet. Hence
 * the nullable `pr` prop and the empty state below: the day a migration lifts
 * that key, making this pane always-available is one line in `availableFileTabs`
 * plus a PR-less queue here, not a rewrite.
 */
import type { AgentKind, ReviewPr } from "../../bindings";
import { EmptyState, Skeleton } from "../../components/primitives";
import { usePrDetail, usePrSummary, useReviewDrafts } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { palette } from "../../theme/colors";
import { ReviewBriefSection } from "./ReviewBriefSection";
import { ReviewWorklist } from "./ReviewWorklist";
import type { StartWorkLauncher } from "./useStartWork";

/** The AI work tab's dot. Two signals, one dot, and **status beats count**: a
 *  stale brief is a claim about whether what you are reading is still true, and
 *  "there are 3 open items" doesn't cancel it. Pure so it can be tested without
 *  rendering a strip — see model.test.ts. */
export function aiWorkDot(staleReview: boolean, openWork: number): string | null {
  if (staleReview) return palette.amber;
  return openWork > 0 ? "var(--accent)" : null;
}

/** What both hosts hand this pane. `pr` is the identity only — the summary it
 *  renders from is fetched here, so "no pull request" and "the PR's summary
 *  hasn't landed yet" stay two different answers. */
interface AiWorkPaneProps {
  pr: { repo: string; number: number } | null;
  /** The santree project, for the review-agent setting and the prompt sources. */
  santreeRepo: string;
  activeReviewAgent: AgentKind | null;
  /** Show a file (and line) from the queue or the reading order — each host jumps
   *  its own way, see this file's comment. */
  onJump: (path: string, line?: number | null) => void;
  /** Hand the open queue items to an agent, and whether that launch is in flight
   *  (it takes seconds, and the button is the one thing guaranteed on screen). */
  startWork: StartWorkLauncher;
  /** Start (or bring forward) the AI review session. */
  onStartReview: (agent?: AgentKind) => void;
  /** …and whether *that* launch is in flight. Only a host whose launcher is
   *  asynchronous sets it: Reviews' request opens a pane on the spot. */
  startingReview?: boolean;
  /** Offer the "run it as a different agent" picker beside the run button. Only a
   *  host that forwards the argument sets it — see {@link ReviewBriefSection}. */
  canPickAgent?: boolean;
}

export function AiWorkPane({ pr, ...host }: AiWorkPaneProps) {
  const { data: summary } = usePrSummary(pr?.repo ?? null, pr?.number ?? 0);

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
  return <Loaded pr={summary} {...host} />;
}

function Loaded({
  pr,
  santreeRepo,
  activeReviewAgent,
  onJump,
  startWork,
  onStartReview,
  startingReview,
  canPickAgent,
}: Omit<AiWorkPaneProps, "pr"> & { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { data: drafts = [] } = useReviewDrafts(pr.repo, pr.number);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <ReviewWorklist
        pr={pr}
        detail={detail}
        drafts={drafts}
        onFocusFile={onJump}
        onStartWork={startWork.start}
        startingWork={startWork.starting}
      />
      <ReviewBriefSection
        pr={pr}
        activeReviewAgent={activeReviewAgent}
        santreeRepo={santreeRepo}
        onJump={onJump}
        onStartReview={onStartReview}
        startingReview={startingReview}
        canPickAgent={canPickAgent}
      />
    </div>
  );
}
