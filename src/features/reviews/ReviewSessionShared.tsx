import type { AgentKind, ReviewPr, ReviewTarget } from "../../bindings";
import { AgentIcon, TrashIcon, WarningIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import { useRemoveReviewWorkspace } from "../../lib/queries";
import { useReviewsModel } from "./model";
import { ticketIdFor } from "./ticket";

/** The identity review commands take, derived from the already-loaded list row. */
export function reviewTargetFor(pr: ReviewPr): ReviewTarget {
  return {
    prRepo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    ticketId: ticketIdFor(pr),
  };
}

/** States the review session's guarantees and offers to reclaim its checkout. */
export function ReviewFooter({
  pr,
  agentKind,
  hasWorkspace,
  message,
  extra,
}: {
  pr: ReviewPr;
  agentKind: AgentKind;
  hasWorkspace: boolean;
  message: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const { repo } = useReviewsModel();
  const { mutate: removeWorkspace, isPending } = useRemoveReviewWorkspace(repo);

  return (
    <div className="flex flex-none items-center gap-2 border-t border-hairline bg-raised px-3 py-1.5 text-[10.5px] text-muted-3">
      <AgentIcon kind={agentKind} size={11} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      {extra}
      {!hasWorkspace && (
        <span
          className="flex flex-none items-center gap-1 text-status-amber"
          title="santree has no local clone of this PR's repository, so the session only has the diff. It can't grep the codebase or open files the diff doesn't touch."
        >
          <WarningIcon size={11} />
          diff only
        </span>
      )}
      {hasWorkspace && (
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          title="Delete the local checkout of this PR. It's recreated the next time you open this tab."
          onClick={() =>
            removeWorkspace({ prRepo: pr.repo, number: pr.number, headSha: pr.headSha })
          }
        >
          <TrashIcon size={10} />
          Remove checkout
        </Button>
      )}
    </div>
  );
}
