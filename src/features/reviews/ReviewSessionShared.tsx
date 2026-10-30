import type { AgentKind, ReviewPr, ReviewTarget } from "../../bindings";
import { AgentIcon, TrashIcon, WarningIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import { useReviewsModel } from "./model";
import { ticketIdFor } from "./ticket";
import { useRemoveReviewCheckout } from "./useRemovePrCheckout";

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
  note,
  extra,
}: {
  pr: ReviewPr;
  agentKind: AgentKind;
  hasWorkspace: boolean;
  message: React.ReactNode;
  /** A quiet line above the row, for what the session did to the repo rather than
   *  what it is doing now — it wraps, where {@link message} truncates. */
  note?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const { repo } = useReviewsModel();
  const { remove, pending } = useRemoveReviewCheckout(repo);

  return (
    <div className="flex-none border-t border-hairline bg-raised">
      {note && <p className="px-3 pt-1.5 text-2xs leading-[1.45] text-muted-4">{note}</p>}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-3">
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
            disabled={pending}
            title="Delete the local checkout of this PR and end its AI reviews. Reviewing it again cuts a new one."
            onClick={() => remove(pr)}
          >
            <TrashIcon size={10} />
            Remove checkout
          </Button>
        )}
      </div>
    </div>
  );
}
