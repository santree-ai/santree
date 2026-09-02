/**
 * The right-click menu on a pull request row in the sidebar.
 *
 * The row opens the PR in Reviews; the menu is everything else about it that
 * needs no view open: GitHub's own page, the names and numbers you paste — its
 * number, its link, its branch, its ticket — and, once the PR has a checkout on
 * disk, that checkout: open it in Trees, or delete it.
 *
 * Two checkouts can back a PR (see `reviews/checkoutSource`): the worktree
 * "Open as tree" cut, which Trees lists, and the AI review's, which it doesn't.
 * The first is read off the worktree list the tree already holds; the second
 * costs a read of its own, so it is asked for the first time the menu opens
 * rather than once per row of an inbox that can run to dozens.
 */
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useState } from "react";

import type { ReviewPr } from "../../bindings";
import { reviewTreeId } from "../../features/reviews/checkoutSource";
import { ticketIdFor } from "../../features/reviews/ticket";
import { useWorktreeDeletion } from "../../features/trees/useWorktreeDeletion";
import {
  useLinearIssueUrl,
  useRemoveReviewWorkspace,
  useReviewCheckout,
  useWorktreePrs,
  useWorktrees,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { BranchIcon, CopyIcon, GitHubLogo, LinearLogo, LinkIcon, TrashIcon } from "../icons";
import { copyText } from "../menuRows";
import { ConfirmDialog, ContextMenu, type ContextMenuItem } from "../primitives";

export function ReviewPrMenu({ pr, children }: { pr: ReviewPr; children: ReactNode }) {
  const navigate = useNavigate();
  const { setActiveRepo } = useApp();
  const { requestTreeFocus } = useAppUi();
  // The registry's own answer, filled by the inbox that lists this row. A PR
  // from a repo never cloned has none, and nothing here can reach a checkout
  // for it — every read below is off with an empty repo.
  const repo = pr.project ?? "";
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { data: worktrees = [] } = useWorktrees(repo);
  const { data: worktreePrs = [] } = useWorktreePrs(repo);
  const { data: review } = useReviewCheckout(armed ? repo : "", pr.repo, pr.number);
  const linkFor = useLinearIssueUrl(repo);
  const { deleteWorktree } = useWorktreeDeletion(repo);
  const removeReview = useRemoveReviewWorkspace(repo);

  // The same three-way match `usePrCheckout` makes: a tree cut for the PR, one
  // cut for its ticket before the PR existed, or any worktree on its branch.
  const treeId = reviewTreeId(pr);
  const linkedId = worktreePrs.find((candidate) => candidate.url === pr.url)?.issueId;
  const worktree =
    worktrees.find((w) => w.id === treeId || w.id === linkedId || w.branch === pr.headRef) ?? null;
  const checkout = worktree ?? review?.worktree ?? null;
  const ticket = ticketIdFor(pr);
  const ticketUrl = ticket ? linkFor(ticket) : null;

  const items: ContextMenuItem[] = [
    {
      kind: "action",
      key: "github",
      label: "Open on GitHub",
      icon: <GitHubLogo size={12} />,
      run: () => void openUrl(pr.url),
    },
    { kind: "rule", key: "rule-copy" },
    {
      kind: "action",
      key: "copy-number",
      label: "Copy PR number",
      icon: <CopyIcon size={13} />,
      run: () => copyText(`#${pr.number}`, "PR number"),
    },
    {
      kind: "action",
      key: "copy-link",
      label: "Copy link",
      icon: <LinkIcon size={13} />,
      run: () => copyText(pr.url, "Link"),
    },
    {
      kind: "action",
      key: "copy-branch",
      label: "Copy branch",
      icon: <BranchIcon size={13} />,
      run: () => copyText(pr.headRef, "Branch"),
    },
    ...(ticket
      ? ([
          { kind: "rule", key: "rule-ticket" },
          {
            kind: "action",
            key: "open-linear",
            label: "Open ticket in Linear",
            icon: <LinearLogo size={12} />,
            disabled: ticketUrl === null,
            run: () => {
              if (ticketUrl) void openUrl(ticketUrl);
            },
          },
          {
            kind: "action",
            key: "copy-ticket",
            label: "Copy ticket id",
            icon: <CopyIcon size={13} />,
            run: () => copyText(ticket, "Ticket id"),
          },
        ] satisfies ContextMenuItem[])
      : []),
    ...(checkout
      ? ([
          { kind: "rule", key: "rule-checkout" },
          // Only the PR's own worktree opens: Trees doesn't list a review
          // checkout, so there is nowhere to land.
          ...(worktree
            ? ([
                {
                  kind: "action",
                  key: "open-worktree",
                  label: "Open worktree",
                  icon: <BranchIcon size={12} />,
                  run: () => {
                    setActiveRepo(repo);
                    requestTreeFocus(worktree.id, { fromSidebar: true });
                    navigate({ to: "/trees" });
                  },
                },
              ] satisfies ContextMenuItem[])
            : []),
          {
            kind: "action",
            key: "delete",
            label: worktree ? "Delete worktree" : "Delete review checkout",
            icon: <TrashIcon size={13} />,
            danger: true,
            run: () => setConfirming(true),
          },
        ] satisfies ContextMenuItem[])
      : []),
  ];

  return (
    <>
      {/* `contents`: no box of its own, so the card keeps its place in the
          row's flex line beside the stack connector. */}
      <ContextMenu items={items} className="contents" onOpen={() => setArmed(true)}>
        {children}
      </ContextMenu>
      <ConfirmDialog
        open={confirming}
        danger
        title={worktree ? "Delete worktree" : "Delete review checkout"}
        confirmLabel="Delete"
        message={
          worktree ? (
            <>
              Delete the worktree for <span className="font-mono text-fg-2">{worktree.id}</span> and
              its branch <span className="font-mono text-fg-2">{worktree.branch}</span>? Any
              uncommitted changes will be lost.
            </>
          ) : (
            <>
              Delete the review checkout for{" "}
              <span className="font-mono text-fg-2">#{pr.number}</span>? Reviewing it again cuts a
              new one.
            </>
          )
        }
        // Fire and close, as the worktree row's own menu does: the removal runs
        // in the background and rolls back with a toast on error.
        onConfirm={() => {
          if (worktree) deleteWorktree(worktree.id);
          else removeReview.mutate({ prRepo: pr.repo, number: pr.number, headSha: pr.headSha });
          return Promise.resolve();
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
