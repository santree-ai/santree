/**
 * The local checkout behind a pull request you are reviewing — what the rail's
 * Files, Changes and Session-history panes are *about*.
 *
 * A PR is a set of commits on a server; those three panes are all facts about a
 * branch on disk, so they need one. Two can back them, and {@link checkoutSource}
 * is the rule for which: the PR's own worktree — the one "Open as tree" cuts, at
 * {@link reviewTreeId} — and, failing that, the AI review's checkout under
 * `.santree/reviews/`. The second is detached at the head it was cut from and
 * pruned to a fixed budget, so a pane showing it says so: it is somewhere to read
 * the PR, not somewhere to keep work.
 *
 * Most PRs have neither, because a worktree is only cut when someone opens the
 * tree or starts work on it, and a review checkout only when an AI review runs.
 * That is a state the panes render, not a reason to hide their tabs: a strip whose
 * tabs appear and disappear as you click around it is harder to trust than a tab
 * with an honest empty state.
 */
import { useNavigate } from "@tanstack/react-router";

import type { ReviewPr, Worktree } from "../../bindings";
import { BranchIcon, DownloadIcon, TrashIcon } from "../../components/icons";
import { Button, EmptyState, Spinner } from "../../components/primitives";
import {
  useCreateWorktree,
  usePromoteReviewWorktree,
  usePullRemoteWorktree,
  useRepos,
  useReviewCheckout,
  useReviewWorkspaceCutting,
  useWorktreePrs,
  useWorktrees,
} from "../../lib/queries";
import { useOptionalAgentRuns } from "../../state/AgentRuns";
import { useAppUi } from "../../state/AppContext";
import {
  type CheckoutSource,
  checkoutSource,
  needsPull,
  openTreeAction,
  REVIEW_CHECKOUT_NOTE,
  reviewTreeId,
} from "./checkoutSource";
import { useReviewsModel } from "./model";
import { useRemoveReviewCheckout } from "./useRemovePrCheckout";
import { useWorktreeGate } from "./WorktreeGate";

export interface PrCheckout {
  /** The santree project the PR's repo belongs to, or `""` when no registered
   *  checkout has it as its origin. Every worktree-scoped read keys off it, and
   *  `""` is what leaves them all disabled. */
  repo: string;
  /** The worktree checked out on the PR's head branch, once there is one. This
   *  is the PR's *own* tree — never the review checkout, so "Open as tree" and
   *  the tab strip's "work in the checkout" keep meaning what they say. */
  worktree: Worktree | null;
  /** Its id, or `""` when there is none — again, a disabled read rather than one
   *  fetched against a guess. */
  worktreeId: string;
  /** What the branch panes actually read: the worktree above, or the AI review's
   *  detached checkout when there is none. */
  source: CheckoutSource;
  /** Cut the worktree and go to it, the same action the PR header offers. */
  openAsTree: () => void;
  /** A checkout for this PR is being made or kept right now — by "Open as tree"
   *  or by an AI review's own lazy create — whichever view started it. Read off
   *  app-wide state rather than the mutation, so it is true for a PR the user
   *  left and came back to, and for every hook instance asking about it. */
  opening: boolean;
  /** Whether both reads that decide {@link PrCheckout.source} have answered.
   *  Until they have, "no checkout" is *unknown*, not empty: an action that
   *  would ask to create one must wait rather than offer a duplicate. */
  known: boolean;
  /** False when the PR's repo isn't a registered project: there is nowhere to
   *  cut a worktree, and no waiting will change that. */
  canOpen: boolean;
}

/**
 * Resolve (and, on demand, create) the PR's worktree, plus the review checkout
 * the panes fall back to.
 *
 * The lookup is deliberately wider than the id: a tree cut by "Start work"
 * carries its *ticket's* id, not {@link reviewTreeId}, so matching the id alone
 * would tell a reviewer there is no checkout while the header beside it offers
 * to show them one. Branch and PR link cover both.
 *
 * `openAsTree` is the header's own flow — placeholder row, repo switch, create,
 * focus — and creating it here rather than navigating first would be a *second*
 * flow, with its own bugs, for the same worktree. The header still holds an
 * inline copy of this; when the two converge, they converge here.
 */
export function usePrCheckout(pr: ReviewPr): PrCheckout {
  const navigate = useNavigate();
  const { pendingLaunches, addPendingLaunches, removePendingLaunch, requestTreeFocus } = useAppUi();
  // The PR's *own* project, never whichever one the app happens to be pointed at:
  // the inbox spans the registry, so the two are routinely different repos and
  // the fallback would look for this branch in someone else's checkout. `null`
  // here means no registered project has this repo as its origin — which is also
  // the honest answer to "where is it checked out": nowhere it could be.
  //
  // `project` is the registry's own answer and the right one whenever the inbox
  // filled it. It is `None` on the by-number path that serves a worktree's own
  // PR, though, and there the slug is all there is — so fall back to a registered
  // project named after it, which is the rule `ReviewHeader` used to apply on its
  // own before the two flows converged here.
  const { data: repos = [] } = useRepos();
  const repo =
    pr.project ??
    repos.find((candidate) => candidate.name.toLowerCase() === pr.repo.toLowerCase())?.name ??
    "";
  const { data: worktrees = [], isFetched: worktreesFetched } = useWorktrees(repo);
  const { data: worktreePrs = [], isFetched: prsFetched } = useWorktreePrs(repo);
  // `mutateAsync`, not `mutate` with callbacks: this view is keyed per PR, so
  // picking another PR (or the navigation to Trees right below) unmounts it
  // while the create is still running — and TanStack drops a per-call
  // `onSuccess`/`onError` once the observer is gone. A promise continuation
  // outlives the view, which is what lets several PRs be checked out at once.
  const { mutateAsync: createTree } = useCreateWorktree();
  const askForWorktree = useWorktreeGate();
  const agentRuns = useOptionalAgentRuns();
  // Addressed through the *active* repo, the way every other review command is:
  // the checkout may live under a clone other than the one the PR is attributed
  // to, and the answer names which project it did land in.
  const { repo: santreeRepo } = useReviewsModel();
  const { data: review, isFetched: reviewFetched } = useReviewCheckout(
    santreeRepo,
    pr.repo,
    pr.number,
  );
  const promote = usePromoteReviewWorktree(santreeRepo);

  const treeId = reviewTreeId(pr);
  // Two ways a checkout is under way for this PR, both app-wide so they survive
  // the view being left: the placeholder `openAsTree` plants, and the AI
  // review's find-or-create read (its pane may be unmounted by now; the read
  // is not).
  const reviewCutting = useReviewWorkspaceCutting(santreeRepo, pr.repo, pr.number);
  const creating =
    reviewCutting || pendingLaunches.some((launch) => launch.repo === repo && launch.id === treeId);
  const opening = creating || promote.isPending;
  const linkedId = worktreePrs.find((candidate) => candidate.url === pr.url)?.issueId;
  const worktree =
    worktrees.find((w) => w.id === treeId || w.id === linkedId || w.branch === pr.headRef) ?? null;

  const openAsTree = () => {
    if (!repo || worktree || opening) return;
    // Already checked out for review: there is nothing to cut, only a label to
    // drop. No dialog either — nothing new reaches the disk, so asking would be
    // a confirmation for an action that has no consequence to confirm.
    if (review) {
      promote.mutate(
        { prRepo: pr.repo, number: pr.number },
        {
          onSuccess: () => {
            navigate({
              to: "/trees",
              search: { project: review.repo, tree: review.worktree.id },
            });
            requestTreeFocus(review.repo, review.worktree.id);
          },
        },
      );
      return;
    }
    // Cutting one *is* a consequence — a working tree on disk — so it is asked
    // for by name, with the setup script offered beside it and off by default.
    void askForWorktree("Opening this pull request as a tree").then((choice) => {
      if (!choice.ok) return;
      // No project on the placeholder: a PR is not one, and the row is merged
      // straight into the sidebar's worktree list, where a stand-in would open a
      // band of its own.
      addPendingLaunches([{ repo, id: treeId, title: pr.title, project: null, agent: null }]);
      navigate({ to: "/trees", search: { project: repo, tree: treeId } });
      createTree({
        repo,
        issueId: treeId,
        title: pr.title,
        launch: { type: "pr", prRepo: pr.repo, branch: pr.headRef },
        base: pr.baseRef || null,
        // Deliberately no agent: Trees owns provider choice through its
        // persisted `+` tabs.
        agent: null,
      }).then(
        (tree) => {
          // No focus request here: the navigation above already took the user to
          // this tree, and by the time a create lands they may be somewhere else.
          removePendingLaunch(treeId);
          // The one thing the dialog asked about. Run after the create, never
          // as part of it: `init.sh` takes minutes and streams its own output.
          if (choice.runSetup) agentRuns?.runSetup(repo, tree.id);
        },
        // The failure itself is toasted by the global mutation policy.
        () => removePendingLaunch(treeId),
      );
    });
  };

  return {
    repo,
    worktree,
    worktreeId: worktree?.id ?? "",
    source: checkoutSource(repo, worktree, review),
    openAsTree,
    opening,
    known: (!repo || (worktreesFetched && prsFetched)) && (!santreeRepo || reviewFetched),
    canOpen: !!repo,
  };
}

/** What the three checkout-backed panes render until there is one to read.
 *
 *  It says the same thing in all three because it is the same missing fact, and
 *  it offers the one action that fixes it — the header's "Open as tree", which
 *  goes on to Trees, where the worktree it just cut is the whole view. */
export function NoPrCheckout({
  what,
  repo,
  checkout,
}: {
  what: string;
  /** The PR's `owner/name`, for the one case the action can't help with. */
  repo: string;
  checkout: PrCheckout;
}) {
  // The same wording the PR header offers the action under, from the one place
  // it is written — two surfaces naming one button differently is how a user
  // ends up thinking they are two.
  const action = openTreeAction(checkout.source.isReview);
  // The checkout is being cut right now: say so here, where its absence is
  // stated, instead of leaving "No local checkout" up until it lands.
  if (checkout.opening) {
    return (
      <EmptyState
        icon={<Spinner size={14} />}
        title="Creating the checkout…"
        subtitle={`${what} will read it as soon as it's on disk.`}
      />
    );
  }
  return (
    <EmptyState
      icon={<BranchIcon size={16} className="text-muted-4" />}
      title="No local checkout"
      subtitle={
        <>
          {what} needs this pull request checked out as a worktree.{" "}
          {checkout.canOpen
            ? "Opening it as a tree cuts one from the PR's branch."
            : `Add ${repo} as a local project first — there is nowhere to cut one yet.`}
          <span className="mt-3 flex justify-center">
            <Button
              size="sm"
              onClick={checkout.openAsTree}
              disabled={!checkout.canOpen}
              title={
                checkout.canOpen
                  ? action.title
                  : `Add ${repo} as a local repository before opening this PR as a tree`
              }
            >
              <BranchIcon size={11} />
              {action.label}
            </Button>
          </span>
        </>
      }
    />
  );
}

/**
 * The line above the branch panes that says *which* checkout they are showing,
 * and offers the one thing that brings it level with the pull request.
 *
 * It exists because a review checkout is a worktree Trees does not list, so this
 * bar is the only place it is *named* — and therefore the only place its whole
 * lifecycle can be offered. All three live here: pull it level with the branch,
 * keep it (it joins Trees as your own work), or delete it.
 *
 * The delete used to live in the AI review session's footer alone, which was
 * fine while a review tab could not be closed. It can now, and a checkout you
 * cannot see in Trees and cannot reach from a closed tab is one nothing in the
 * app can remove.
 *
 * Nothing renders for a PR worktree that is already current: a bar that is always
 * there is chrome, and chrome is what the reader stops seeing.
 */
export function PrCheckoutBar({ pr, source }: { pr: ReviewPr; source: CheckoutSource }) {
  const { repo: santreeRepo } = useReviewsModel();
  const pullRemote = usePullRemoteWorktree(source.repo);
  const promote = usePromoteReviewWorktree(santreeRepo);
  const removal = useRemoveReviewCheckout(santreeRepo);
  const behindRemote = needsPull(source);
  if (!source.worktree || (!source.isReview && !behindRemote)) return null;

  const behind = source.worktree.remoteBehind;
  const busy = promote.isPending || removal.pending;

  return (
    <div className="flex flex-none flex-col gap-1.5 border-b border-hairline bg-raised px-3 py-2 text-xs leading-[1.5] text-muted-3">
      {source.isReview && <span>{REVIEW_CHECKOUT_NOTE}</span>}
      {behindRemote && (
        <span className="flex">
          <Button
            size="sm"
            variant="ghost"
            disabled={pullRemote.isPending}
            title={`Pull ${behind} commit${behind === 1 ? "" : "s"} from origin/${source.worktree.branch}`}
            onClick={() => pullRemote.mutate(source.worktreeId)}
          >
            {pullRemote.isPending ? <Spinner size={10} /> : <DownloadIcon size={11} />}
            {`Pull ${behind}`}
          </Button>
        </span>
      )}
      {/* The rest of the checkout's life, and the only place it is offered for a
          tree Trees cannot show. Keeping it is the same action the PR header
          offers, from the one place its wording is written. */}
      {source.isReview && (
        <span className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={openTreeAction(true).title}
            onClick={() => promote.mutate({ prRepo: pr.repo, number: pr.number })}
          >
            <BranchIcon size={11} />
            {openTreeAction(true).label}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Delete this pull request's local checkout. Reviewing it again cuts a new one."
            onClick={() => removal.remove(pr)}
          >
            {removal.pending ? <Spinner size={10} /> : <TrashIcon size={10} />}
            Remove checkout
          </Button>
        </span>
      )}
    </div>
  );
}
