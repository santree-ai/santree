/**
 * Says out loud that the diff below is the PR's version of this file, not the
 * branch's, because the branch has commits GitHub hasn't seen.
 *
 * This is the one genuinely dangerous state in showing PR comments beside a local
 * checkout: comment line numbers belong to the pushed head, so on a branch that
 * has moved they would point at code the user isn't looking at. Rather than
 * silently anchor to the wrong lines — or silently drop the comments — the pane
 * names the gap and offers the two ways out.
 */
import type { Worktree } from "../../bindings";
import { PushIcon, WarningIcon } from "../../components/icons";
import { Button, Spinner } from "../../components/primitives";
import { usePushWorktree } from "../../lib/queries";
import { alpha, palette } from "../../theme/colors";
import { useTrees } from "./model";

export function PrSyncNotice({
  worktree,
  onShowPrVersion,
}: {
  worktree: Worktree;
  /** Show the PR's patch anyway. The user has been told; the choice is theirs. */
  onShowPrVersion: () => void;
}) {
  const { repo } = useTrees();
  const { mutate: push, isPending } = usePushWorktree(repo);
  const n = worktree.unpushed;

  return (
    <div
      className="flex flex-none items-center gap-2 border-b px-3 py-1.5 text-[11px]"
      style={{ borderColor: alpha(34, palette.amber), background: alpha(10, palette.amber) }}
    >
      <WarningIcon size={12} className="flex-none text-status-amber" />
      <span className="min-w-0 flex-1 text-fg-3">
        {n} commit{n === 1 ? "" : "s"} {n === 1 ? "isn't" : "aren't"} on GitHub yet. Review comments
        anchor to the pushed version of this file.
      </span>
      <Button size="sm" variant="ghost" className="flex-none" onClick={onShowPrVersion}>
        Show the PR's version
      </Button>
      <Button
        size="sm"
        variant="primary"
        className="flex-none"
        disabled={isPending}
        onClick={() => push(worktree.id)}
      >
        {isPending ? <Spinner size={10} /> : <PushIcon size={11} />}
        Push
      </Button>
    </div>
  );
}
