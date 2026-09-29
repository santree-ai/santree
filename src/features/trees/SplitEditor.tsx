import { useState } from "react";

import type { MoveChanges, Worktree } from "../../bindings";
import { Button, Spinner } from "../../components/primitives";
import {
  useMoveChangesPreview,
  useMoveRemainingChanges,
  useRepoBranches,
  useTasks,
} from "../../lib/queries";
import { toast } from "../../state/toast";
import { invalidBranchReason } from "./createWorktree";
import { useTrees } from "./model";

const FIELD =
  "w-full rounded border border-line bg-input px-3 py-2 text-sm text-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function SplitEditor({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const preview = useMoveChangesPreview(repo, worktree.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-app">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold text-fg">Create a child branch</h2>
        <p className="mt-2 text-sm text-fg-2">
          Commit what belongs here, then move the remaining changes to one child branch.
        </p>
      </div>
      {preview.data ? (
        <MoveForm
          repo={repo}
          preview={preview.data}
          hasCommits={worktree.ahead > 0}
          refreshing={preview.isFetching}
          previewError={preview.error}
          refresh={() => void preview.refetch()}
        />
      ) : preview.isFetching ? (
        <div role="status" className="flex items-center gap-3 p-5 text-sm text-muted-2">
          <Spinner /> Reading uncommitted changes…
        </div>
      ) : (
        <div className="p-5">
          <Failure error={preview.error} />
          <Button onClick={() => void preview.refetch()}>Retry preview</Button>
        </div>
      )}
    </div>
  );
}

function MoveForm({
  repo,
  preview,
  refresh,
  hasCommits,
  refreshing,
  previewError,
}: {
  repo: string;
  preview: MoveChanges;
  refresh: () => void;
  hasCommits: boolean;
  refreshing: boolean;
  previewError: Error | null;
}) {
  const move = useMoveRemainingChanges(repo, preview.sourceId);
  const branches = useRepoBranches(repo);
  const { data: tasks = [] } = useTasks(repo);
  const { setActive, setFileTab, closeSplit, rightCollapsed, toggleRightPanel } = useTrees();
  const [branch, setBranch] = useState(preview.branch ?? "");
  const [ticket, setTicket] = useState(preview.ticketId ?? "");
  const resuming = preview.branch !== null;
  const name = branch.trim();
  const conflict =
    !resuming &&
    branches.data?.some(
      (b) => b.name === name || b.name.startsWith(`${name}/`) || name.startsWith(`${b.name}/`),
    );
  const reason =
    (refreshing
      ? "Updating remaining changes…"
      : previewError
        ? "Refresh the preview before creating a branch."
        : !resuming && !hasCommits
          ? "Commit the first part on this branch before creating a child branch."
          : preview.files.length === 0
            ? "No uncommitted changes to move."
            : null) ??
    invalidBranchReason(name) ??
    (name === "HEAD" || name.startsWith("refs/")
      ? "Choose a regular branch name"
      : conflict
        ? "This branch name already exists or conflicts with another branch"
        : branches.isError
          ? "Branch names could not be loaded"
          : branches.isLoading
            ? "Loading branch names…"
            : null);

  return (
    <div className="flex max-w-2xl flex-col gap-5 p-5">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">1. Commit this branch’s part</h3>
        <p className="text-sm text-fg-2">
          Leave the rest uncommitted. This preview updates automatically after you commit.
        </p>
        <Button
          disabled={move.isPending || resuming}
          onClick={() => {
            setFileTab("changes");
            if (rightCollapsed) toggleRightPanel();
          }}
        >
          Open commit panel
        </Button>
      </section>
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-fg">2. Create one child branch</h3>
        <fieldset disabled={move.isPending || resuming} className="space-y-4">
          <label className="block text-xs text-fg-2">
            Branch name
            <input
              autoComplete="off"
              className={`${FIELD} mt-1`}
              placeholder="e.g. notifications-ui"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          <label className="block text-xs text-fg-2">
            Ticket
            <input
              className={`${FIELD} mt-1`}
              value={ticket}
              placeholder="No ticket"
              list={`move-tickets-${preview.id}`}
              onChange={(e) => setTicket(e.target.value)}
            />
          </label>
          <datalist id={`move-tickets-${preview.id}`}>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </datalist>
          <p className="text-xs text-muted-2">
            Current ticket selected by default. Change it or clear it.
          </p>
        </fieldset>
        <details className="rounded border border-line p-3">
          <summary className="cursor-pointer text-xs font-semibold text-fg-2">
            {preview.files.length} {preview.files.length === 1 ? "file moves" : "files move"} to the
            child branch
          </summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto">
            {preview.files.map((path) => (
              <li key={path} className="break-all font-mono text-xs text-muted-2">
                {path}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-2">
            Staging is preserved and a recovery stash is kept. Ignored files stay here unless
            tracked or staged. Pause agents before moving.
          </p>
        </details>
        {resuming && (
          <p className="text-xs text-fg-2">
            A previous move did not finish. Retry to continue the same move. Your recovery stash and
            any destination edits are preserved.
          </p>
        )}
        <p className="text-xs text-muted-2">
          Creates a worktree from this branch’s latest commit and moves the remaining changes there.
        </p>
        <Failure error={previewError} />
        <Failure error={move.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={move.isPending || !!reason}
            title={reason ?? undefined}
            onClick={() =>
              move.mutate(
                { id: preview.id, branch: name, ticketId: ticket.trim() || null },
                {
                  onSuccess: (result) => {
                    toast.success(
                      result.sourceHasChanges
                        ? "Changes moved. New or remaining edits are still in the previous worktree."
                        : "Remaining changes moved. Your commits stay on the previous branch.",
                    );
                    closeSplit();
                    setActive(result.worktreeId);
                    setFileTab("changes");
                  },
                },
              )
            }
          >
            {move.isPending ? "Moving changes…" : resuming ? "Retry move" : "Create child branch"}
          </Button>
          <Button disabled={move.isPending || refreshing} onClick={refresh}>
            Refresh changes
          </Button>
        </div>
        {reason && <p className="text-xs text-muted-2">{reason}</p>}
        <p className="text-xs text-muted-2">For another split, right-click the child branch.</p>
      </section>
    </div>
  );
}

function Failure({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="text-xs text-status-red">
      {error.message}
    </p>
  ) : null;
}
