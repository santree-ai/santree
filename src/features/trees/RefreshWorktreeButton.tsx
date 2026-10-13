/** Re-read the worktree's local state on demand. It lives in the Changes list's
 *  header row, beside the list/tree toggle: the file list is the one place it is
 *  about, so it is drawn at the toggle's size and shape. See
 *  {@link useRefreshWorktree} for why a watcher is not enough on its own. */
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
      className="flex cursor-pointer items-center rounded-[5px] border border-transparent px-1.5 py-1 text-muted-3 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <RefreshIcon size={12} className={fetching ? "animate-spin" : ""} />
    </button>
  );
}
