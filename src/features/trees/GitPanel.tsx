/** The Changes pane: the branch's state at the top — its name and size, what it
 *  is based on, how far it has drifted from its base and its remote, and every
 *  action that reconciles those (pull, push, Create PR) — then the commit box and
 *  the three lists: working-tree changes, untracked files, and what the branch
 *  has already committed relative to its base.
 *
 *  All of it used to be spread across a top bar and a bottom bar wrapped around
 *  the terminal, which is two rows of chrome describing a list neither of them
 *  could see. Facts and the actions that change them belong beside that list.
 *
 *  The worktree comes in as props so both rails can host it — Trees' own
 *  worktree, and the local checkout of the PR you are reviewing. Everything here
 *  is a fact about a branch on disk and holds either way; the one exception is
 *  {@link CreatePrActions}, which Reviews leaves out. */
import type { ChangedFile, Worktree } from "../../bindings";
import { DownloadIcon, PrIcon, PullIcon, PushIcon } from "../../components/icons";
import { Spinner } from "../../components/primitives";
import {
  usePullRemoteWorktree,
  usePullWorktree,
  usePushWorktree,
  useWorktreeBranchChanges,
} from "../../lib/queries";
import { ChangesList } from "./ChangesList";
import { CommitBox } from "./CommitBox";
import { BASE_ID, type FileScope } from "./model";

/** Shared shape for the pane's small git actions. */
const ACTION =
  "flex h-[20px] flex-none cursor-pointer items-center gap-1 rounded px-1.5 font-mono text-[10.5px] whitespace-nowrap text-muted-2 transition-colors hover:bg-hover hover:text-fg-2 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

/** Opening a pull request for this branch — the one thing the pane cannot answer
 *  for itself, since only the host knows whether the branch already has one.
 *
 *  Absent in the Reviews rail, and that is the point: you are looking at the pull
 *  request, so there is none to create and nothing to suggest after a push. One
 *  optional group rather than three optional props, so a host can't half-wire it
 *  into a "Create PR" button that leads nowhere. */
export interface CreatePrActions {
  /** True once the branch has one. Hides the button and stops the after-commit
   *  prompt — never a reason to hide the pane itself. */
  hasPr: boolean;
  /** Open the create-PR dialog for this worktree. */
  open: () => void;
  /** Called after a push lands, so the host can raise its own PR suggestion. */
  suggestAfterPush: () => void;
}

export function GitPanel({
  repo,
  worktreeId,
  worktree,
  status,
  selectedPath,
  selectedScope,
  onOpen,
  createPr,
}: {
  repo: string;
  worktreeId: string;
  /** The worktree row itself — its branch, its counters, the base it stands on.
   *  Null while the list is still loading, which drops the header rather than
   *  rendering a branch it can't name. */
  worktree: Worktree | null;
  status: ChangedFile[] | undefined;
  selectedPath: string | null;
  selectedScope: FileScope;
  /** See {@link ChangesList.onOpen} — absent leaves the file names inert. */
  onOpen?: (path: string, scope: FileScope) => void;
  createPr?: CreatePrActions;
}) {
  const { data: committed } = useWorktreeBranchChanges(repo, worktreeId);
  // The one action the branch's state calls for: offered while it is ahead of
  // its base with no PR yet, and only where the host can open one (the primary
  // checkout included — its base is the default branch, so a feature branch
  // checked out at the root qualifies too).
  const openPr =
    createPr && !createPr.hasPr && worktree && worktree.ahead > 0 ? createPr.open : null;
  // The branch's size is the sum of what it has committed against its base —
  // the same merge-base diff the "Committed on branch" list shows — not the
  // worktree entry's own counters, which the primary checkout reports as zero.
  const size = committed?.reduce(
    (acc, f) => ({ add: acc.add + f.addLines, del: acc.del + f.delLines }),
    { add: 0, del: 0 },
  );

  return (
    <>
      {worktree && (
        <div className="flex flex-none flex-col gap-1 border-b border-line px-3 py-2.5">
          {openPr && (
            <div className="mb-1 flex items-center">
              <button
                type="button"
                onClick={openPr}
                title="Open a pull request for this branch"
                className="flex h-6 cursor-pointer items-center gap-1.5 rounded-full bg-fg px-2.5 text-[11px] font-semibold text-app transition-opacity hover:opacity-85"
              >
                <PrIcon size={12} />
                Create PR
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2"
              title={worktree.branch}
            >
              {worktree.branch}
            </span>
            {size && (
              <span
                className="flex flex-none items-center gap-1.5 font-mono text-[10.5px] tabular-nums"
                title="Lines added and removed on this branch, against its base"
              >
                <span className="text-status-green">+{size.add.toLocaleString()}</span>
                <span className="text-status-red">−{size.del.toLocaleString()}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <BaseSync repo={repo} worktree={worktree} />
            <span className="min-w-1 flex-1" />
            <PullRemote repo={repo} worktree={worktree} />
            <Push repo={repo} worktree={worktree} onPushed={createPr?.suggestAfterPush} />
          </div>
        </div>
      )}

      {/* Keyed per worktree so each gets its own persisted-draft instance. */}
      <CommitBox
        key={worktreeId}
        repo={repo}
        worktreeId={worktreeId}
        stagedCount={(status ?? []).filter((f) => f.staged).length}
        totalCount={status?.length ?? 0}
        createPr={createPr}
      />

      <ChangesList
        repo={repo}
        worktreeId={worktreeId}
        files={status}
        committed={committed}
        selectedPath={selectedPath}
        selectedScope={selectedScope}
        onOpen={onOpen}
      />
    </>
  );
}

/** The base branch this worktree stands on: its name, how far ahead of it the
 *  branch is, how far behind — and, when it is behind, one click to pull the base
 *  in. The base here is whatever the worktree branched off (the repo's default
 *  branch for a top-level worktree, the parent's branch for a stacked one), so
 *  the same control restacks either kind.
 *
 *  Syncing the *local base branch itself* from origin is a repo-level action that
 *  never touches this worktree, so it stays on the sidebar's base entry rather
 *  than becoming a second thing this button might mean. */
function BaseSync({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const { mutate: pull, isPending } = usePullWorktree(repo);
  const { ahead, behind, baseBranch } = worktree;
  // The base entry has no base of its own to be measured against.
  if (worktree.id === BASE_ID) return null;
  const canPull = behind > 0;

  return (
    <button
      type="button"
      disabled={!canPull || isPending}
      onClick={() => pull(worktree.id)}
      title={
        canPull
          ? `Pull ${baseBranch} into this worktree (${behind} behind, ${ahead} ahead)`
          : `Up to date with ${baseBranch}${ahead > 0 ? ` (${ahead} ahead)` : ""}`
      }
      className={`${ACTION} min-w-0 text-muted-4`}
    >
      {isPending ? <Spinner size={10} /> : canPull ? <PullIcon size={11} /> : <span>→</span>}
      <span className="min-w-0 truncate">{baseBranch}</span>
      {ahead > 0 && <span className="flex-none text-status-green tabular-nums">↑{ahead}</span>}
      {behind > 0 && <span className="flex-none text-status-amber tabular-nums">↓{behind}</span>}
    </button>
  );
}

/** "Pull" — only while the branch's own remote has commits that aren't local yet
 *  (a PR-UI suggestion, "Update branch", a teammate's push). Fast-forwards from
 *  origin/<branch> when it can, else merges. Disabled rather than hidden when the
 *  pull would conflict, so the count is still readable and the tooltip says where
 *  to resolve it. */
function PullRemote({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const { mutate: pullRemote, isPending } = usePullRemoteWorktree(repo);
  const n = worktree.remoteBehind;
  if (n === 0) return null;
  const commits = `${n} commit${n === 1 ? "" : "s"}`;
  const conflict = worktree.pullConflict;
  return (
    <button
      type="button"
      onClick={() => pullRemote(worktree.id)}
      disabled={isPending || conflict}
      title={
        conflict
          ? `Pulling ${commits} would conflict with your local changes. Resolve it in the worktree (open Terminal → git merge origin/${worktree.branch})`
          : `Pull ${commits} from origin/${worktree.branch}`
      }
      className={ACTION}
    >
      {isPending ? <Spinner size={10} /> : <DownloadIcon size={11} />}
      Pull {n}
    </button>
  );
}

/** "Push" — only while the branch has commits its remote doesn't. Pushes to
 *  origin (setting upstream); the count clears on the next worktree refetch. */
function Push({
  repo,
  worktree,
  onPushed,
}: {
  repo: string;
  worktree: Worktree;
  /** What follows a push, when the host has something to follow it with. */
  onPushed?: () => void;
}) {
  const { mutate: push, isPending } = usePushWorktree(repo);
  // Nothing to suggest for the base branch — you don't open a PR against main.
  const suggest = worktree.id === BASE_ID ? undefined : onPushed;
  const n = worktree.unpushed;
  if (n === 0) return null;
  return (
    <button
      type="button"
      onClick={() => push(worktree.id, suggest ? { onSuccess: suggest } : undefined)}
      disabled={isPending}
      title={`Push ${n} commit${n === 1 ? "" : "s"} to origin`}
      className={ACTION}
    >
      {isPending ? <Spinner size={10} /> : <PushIcon size={11} />}
      Push {n}
    </button>
  );
}
