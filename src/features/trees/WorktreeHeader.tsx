/** The worktree workspace's own header row — what the window's top bar used to
 *  say about the selection, now said by the view that owns it.
 *
 *  Left: the worktree's title and its branch (mono), then the diff shape it
 *  carries (`+adds −dels` and the number of changed files). Right: the actions
 *  that act on *this* worktree while you're looking at it — Commit (reveals the
 *  file picker's Changes tab, where the commit box lives), Create PR, and
 *  Open in…. The remaining per-worktree actions (push/pull, setup, delete, the
 *  files toggle) stay on {@link BottomBar}. */
import type { Worktree } from "../../bindings";
import { CheckIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { WorktreeStats } from "../../components/WorktreeStats";
import { useWorktreeStatus } from "../../lib/queries";
import { ITEM, OpenInMenu, PrButton } from "./BottomBar";
import { BASE_ID, useTrees } from "./model";

export function WorktreeHeader({ worktree }: { worktree: Worktree }) {
  const { repo, rightCollapsed, toggleRightPanel, setFileTab } = useTrees();
  // The base-branch entry isn't a per-issue worktree: it has no PR to open.
  const isBase = worktree.id === BASE_ID;
  // `undefined` while the first `git status` is in flight — render no count
  // rather than asserting "0 files", which would be a claim we can't make yet.
  const { data: status } = useWorktreeStatus(repo, worktree.id);
  const changed = status?.length;

  // The commit box lives in the file picker's Changes tab, so "Commit" is the
  // one door to it: show the panel if it's hidden, and switch it to Changes.
  const commit = () => {
    setFileTab("changes");
    if (rightCollapsed) toggleRightPanel();
  };

  return (
    <div className="flex h-11 flex-none items-center gap-2.5 border-b border-line bg-surface pr-2 pl-3">
      {/* Capped rather than shrinkable: a long ticket title truncates instead of
          squeezing the branch and the stats off the row. */}
      <MarkdownTitle
        title={worktree.title}
        className="max-w-[40%] flex-none truncate text-[12.5px] font-semibold text-fg-bright"
      >
        {worktree.title}
      </MarkdownTitle>
      <span
        title={worktree.branch}
        className="max-w-[28%] flex-none truncate font-mono text-[10.5px] text-muted-3"
      >
        {worktree.branch}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[10.5px] text-muted-4">
        <WorktreeStats worktree={worktree} />
        {changed !== undefined && changed > 0 && (
          <span>
            {changed} {changed === 1 ? "file" : "files"}
          </span>
        )}
      </span>

      <div className="flex flex-none items-center gap-1 text-[11px] text-muted-2">
        <button
          type="button"
          onClick={commit}
          title="Review and commit the changed files"
          className={ITEM}
        >
          <CheckIcon size={12} />
          Commit
          {changed !== undefined && changed > 0 && (
            <span className="font-mono text-[9.5px] opacity-70">{changed}</span>
          )}
        </button>
        {!isBase && <PrButton worktree={worktree} />}
        <OpenInMenu path={worktree.path} placement="down" />
      </div>
    </div>
  );
}
