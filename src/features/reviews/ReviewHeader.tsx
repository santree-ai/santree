/**
 * The Reviews detail header, in the shape GitHub's own pull-request page opens
 * with: the title carrying its `#number`, then the state pill and the sentence
 * that says what the PR proposes — "someone wants to merge 3 commits into main
 * from a-branch" — then what the review needs (decision, checks, reviewers,
 * labels). Actions stay on the right of the first row.
 *
 * The number belongs *to* the heading rather than above it because it is part of
 * how a PR is named out loud ("look at 54760"), and a line of its own reads as
 * metadata about the title instead.
 *
 * It opens the Pull Request tab — the PR's identity above its own sections — and
 * carries no window chrome of its own: the diffstat rides the "Files changed" tab
 * it describes, and the rail's toggle lives on the main tab strip, where it is
 * reachable from every tab rather than from this one.
 *
 * Host-agnostic: it reads no view model. The one thing a host decides is whether
 * the tree actions (View tree · Open as tree) are on offer, and it says so by
 * passing the PR's checkout — Reviews does for someone else's PR and withholds
 * it for your own; Trees, which only ever shows your own beside its worktree,
 * never passes one.
 */

import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { PrState, Reviewer, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import {
  AgentsIcon,
  BranchIcon,
  CopyIcon,
  GitHubLogo,
  PrClosedIcon,
  PrIcon,
  PrMergedIcon,
} from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, Pill } from "../../components/primitives";
import { usePrDetail } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import {
  mergeQueueMeta,
  type PrPageState,
  prStatePill,
  prStatePillMeta,
  reviewDecisionMeta,
} from "../../theme/colors";
import { openTreeAction } from "./checkoutSource";
import type { PrCheckout } from "./PrCheckout";
import { PrLabels } from "./PrLabels";
import { PR_COLUMN } from "./prLayout";

export function ReviewHeader({
  pr,
  checkout,
}: {
  pr: ReviewPr;
  /** The PR's local checkout — the one create-or-keep flow, shared with the
   *  rail's empty states (see `usePrCheckout`). Given, the header offers the tree
   *  actions off it; omitted, it offers none — the host's way of saying the PR is
   *  the viewer's own, worked on in Trees rather than checked out from here. */
  checkout?: PrCheckout;
}) {
  const { requestTreeFocus } = useAppUi();
  const existingTree = checkout?.worktree ?? null;
  const navigate = useNavigate();
  const decision = reviewDecisionMeta[pr.reviewDecision];
  // The same cached read the tabs and the Commits pane use, not a second fetch.
  // Absent until it lands, which is what keeps the sentence honest.
  const [prOwner, prName] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(prOwner, prName, pr.number);
  const commitCount = detail ? detail.commits.length : null;
  // How the action names itself: with the PR already checked out for review, the
  // panes beside this header are showing its files and there is nothing to cut —
  // only the review label to drop (see `openTreeAction`).
  const treeAction = openTreeAction(checkout?.source.isReview ?? false);

  const viewTree = () => {
    if (!checkout?.repo || !existingTree) return;
    navigate({ to: "/trees", search: { project: checkout.repo, tree: existingTree.id } });
    requestTreeFocus(checkout.repo, existingTree.id);
  };

  return (
    <div className="flex-none border-b border-hairline px-5 pt-3.5 pb-2">
      <div className={PR_COLUMN}>
        {/* Identity on the left, actions on the right. No repo breadcrumb: you
          reached this PR from its own project's section in the sidebar, and the
          base and head branches are named a line below — the slug spent a row
          telling you where you already knew you were. It still rides the "Open in
          GitHub" tooltip, which is the one place it is a fact you might need. */}
        <div className="mb-2 flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {/* Inline, not a flex row: a long title wraps and the number trails its
              last word, the way GitHub sets it — and the verdict trails the number,
              because "has this been approved" is the question the heading is read
              to answer. */}
            <h1 className="text-[19px] leading-[1.28] font-semibold text-fg-bright">
              <MarkdownTitle>{pr.title}</MarkdownTitle>{" "}
              <span className="font-normal text-muted-4">#{pr.number}</span>{" "}
              <Pill
                color={decision.color}
                className="align-[3px] px-1.5 py-px text-[10px] font-medium"
              >
                {decision.label}
              </Pill>
              {pr.isInMergeQueue && (
                <>
                  {" "}
                  <Pill
                    color={mergeQueueMeta.color}
                    className="align-[3px] px-1.5 py-px text-[10px] font-medium"
                  >
                    {mergeQueueMeta.glyph} {mergeQueueMeta.label}
                  </Pill>
                </>
              )}
            </h1>
          </div>
          <div className="flex min-w-0 max-w-full flex-none flex-wrap items-center justify-end gap-2">
            {checkout && existingTree && (
              <Button
                size="sm"
                onClick={viewTree}
                title="Show the existing tree"
                className="flex-none"
              >
                <BranchIcon size={11} />
                View tree
              </Button>
            )}
            {checkout && !existingTree && checkout.canOpen && (
              <Button
                size="sm"
                onClick={checkout.openAsTree}
                disabled={checkout.opening}
                title={treeAction.title}
                className="flex-none"
              >
                <BranchIcon size={11} />
                {treeAction.label}
              </Button>
            )}
            {checkout && !checkout.canOpen && (
              <Button
                size="sm"
                disabled
                title={`Add ${pr.repo} as a local repository before opening this PR as a tree`}
                className="flex-none"
              >
                <BranchIcon size={11} />
                {treeAction.label}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => openUrl(pr.url)}
              title={`Open ${pr.repo}#${pr.number} on GitHub`}
              className="flex-none"
            >
              <GitHubLogo size={11} />
              Open in GitHub
            </Button>
          </div>
        </div>
        {/* One line, always. It used to wrap, which put "into <base>" on one row
            and "from <head>" on the next — and the sentence only reads as a
            sentence while both halves of the comparison are side by side. So
            nothing wraps and the branch names give up width instead: they carry
            an ellipsis and their full text a hover away, which is the trade
            branch names are built for (they are already truncated at 240/300px
            on a wide window). The shrink weights are the priority order — the
            chips absorb the squeeze first, and the sentence only starts losing
            words once they are down to their stubs. */}
        <div className="mb-2 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-2">
          <span className="flex flex-none items-center gap-2">
            <StatePill state={pr.state} isDraft={pr.isDraft} />
            <Avatar name={pr.author} src={pr.authorAvatarUrl} size={16} />
          </span>
          <span className="min-w-0 shrink-[0.05] truncate">
            <span className="font-medium text-fg-2">{pr.author}</span> wants to merge{" "}
            {commitPhrase(commitCount)} into
          </span>
          <span
            title={pr.baseRef}
            className="min-w-[3.5rem] max-w-[240px] truncate rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[10.5px] text-[color:var(--color-branch)]"
          >
            {pr.baseRef}
          </span>
          <span className="flex-none">from</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(pr.headRef);
              toast.success("Branch copied.");
            }}
            title={`Copy branch — ${pr.headRef}`}
            className="group flex min-w-0 max-w-[300px] cursor-pointer items-center gap-1.5 rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[10.5px] text-[color:var(--color-branch)] hover:border-line-strong"
          >
            <BranchIcon size={10} className="flex-none" />
            <span className="truncate">{pr.headRef}</span>
            <CopyIcon size={10} className="flex-none text-muted-3 group-hover:text-fg-2" />
          </button>
        </div>
        {/* No check rollup here: the Checks tab wears the same glyph in the same
          colour a few pixels below, and two of them disagreed about nothing while
          costing a whole row. */}
        {pr.reviewers.length > 0 && <Reviewers reviewers={pr.reviewers} />}
        <PrLabels pr={pr} />
      </div>
    </div>
  );
}

/** The icon-and-word pill GitHub opens a pull request with. */
const STATE_ICON: Record<PrPageState, typeof PrIcon> = {
  Open: PrIcon,
  Draft: PrIcon,
  Merged: PrMergedIcon,
  Closed: PrClosedIcon,
};

function StatePill({ state, isDraft }: { state: PrState; isDraft: boolean }) {
  const key = prStatePill(state, isDraft);
  const meta = prStatePillMeta[key];
  const Icon = STATE_ICON[key];
  return (
    <Pill
      color={meta.color}
      title={`${meta.label} pull request`}
      className="gap-1 px-2 py-0.5 text-[11px] font-medium"
    >
      <Icon size={11} />
      {meta.label}
    </Pill>
  );
}

/**
 * The commit half of the header sentence: "3 commits", "1 commit", or a bare
 * "commits" while the detail read that carries the list is still in flight.
 *
 * `null` is not zero. A pull request with no commits does not exist, so printing
 * "0 commits" while the fetch lands would be santree making a claim about the PR
 * that is never true — and nothing tells the reader it isn't a real answer.
 */
export function commitPhrase(count: number | null): string {
  if (count == null) return "commits";
  return `${count.toLocaleString()} commit${count === 1 ? "" : "s"}`;
}

/** Requested reviewers on the PR — people as avatar+login chips, teams as a
 *  bordered chip with a people glyph. */
function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
      <span className="text-muted-4">Reviewers</span>
      {reviewers.map((r) =>
        r.kind === "User" ? (
          <span key={`u:${r.name}`} className="flex items-center gap-1 text-muted-2">
            <Avatar name={r.name} src={r.avatarUrl} size={15} />
            {r.name}
          </span>
        ) : (
          <span
            key={`t:${r.name}`}
            className="flex items-center gap-1 rounded-md border border-line-2 bg-input px-1.5 py-0.5 text-[10px] text-muted-2"
            title={`Team: ${r.name}`}
          >
            <AgentsIcon size={11} />
            {r.name}
          </span>
        ),
      )}
    </div>
  );
}
