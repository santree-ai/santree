/** Re-read the worktree's local state on demand — the rail's own refresh.
 *
 *  It sits in the panel header rather than inside one pane because the three
 *  panes it serves (Files, Changes, Session history) all read the same thing:
 *  what is on disk right now. See {@link useRefreshWorktree} for why a watcher
 *  is not enough on its own. */
import { RefreshIcon } from "../../components/icons";
import { useRefreshWorktree } from "../../lib/queries";

export function RefreshWorktreeButton({ repo, worktreeId }: { repo: string; worktreeId: string }) {
  const { refresh, fetching } = useRefreshWorktree(repo, worktreeId);
  return (
    <button
      type="button"
      onClick={refresh}
      // Never disabled while fetching: the spinner also reflects the watcher's
      // own refetches, and those must not swallow a click — the click is the
      // whole point when what is on screen looks stale.
      aria-busy={fetching}
      aria-label="Refresh files and git status"
      title="Refresh files and git status"
      className="flex h-[22px] w-7 flex-none cursor-pointer items-center justify-center self-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <RefreshIcon size={12} className={fetching ? "animate-spin" : ""} />
    </button>
  );
}
