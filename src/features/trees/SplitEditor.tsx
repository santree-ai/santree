import { useId, useState } from "react";

import type { MoveChanges, Worktree } from "../../bindings";
import { ChevronDownIcon } from "../../components/icons";
import { Button, Dropdown, MENU_ITEM, Spinner } from "../../components/primitives";
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
  "w-full rounded border border-line bg-input px-2.5 py-1.5 text-xs text-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function SplitEditor({ repo, worktree }: { repo: string; worktree: Worktree }) {
  const preview = useMoveChangesPreview(repo, worktree.id);
  return (
    <div className="w-full min-w-0">
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
  const { setActive, setFileTab, closeSplit } = useTrees();
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
    <div className="flex w-full min-w-0 flex-col gap-3 p-3">
      <p className="text-xs text-muted-2">
        Commit what belongs here, then move the rest to a child branch.
      </p>
      <section className="space-y-3">
        <fieldset disabled={move.isPending || resuming} className="space-y-3">
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
          <TicketPicker
            value={ticket}
            onChange={setTicket}
            tasks={tasks}
            disabled={move.isPending || resuming}
          />
        </fieldset>
        {preview.files.length > 0 && (
          <p className="text-xs text-fg-2">
            {preview.files.length} {preview.files.length === 1 ? "file" : "files"} will move.
            Staging is preserved.
          </p>
        )}
        {resuming && (
          <p className="text-xs text-fg-2">
            A previous move did not finish. Retry to continue the same move. Your recovery stash and
            any destination edits are preserved.
          </p>
        )}
        <p className="text-xs text-muted-2">
          Pause agents before moving. A recovery stash is kept.
        </p>
        <Failure error={previewError} />
        <Failure error={move.error} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
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
          <Button
            size="sm"
            variant="ghost"
            disabled={move.isPending || refreshing}
            onClick={refresh}
          >
            Refresh changes
          </Button>
        </div>
        {reason && <p className="text-xs text-muted-2">{reason}</p>}
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

function TicketPicker({
  value,
  onChange,
  tasks,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  tasks: { id: string; title: string }[];
  disabled: boolean;
}) {
  const labelId = useId();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = tasks.filter((task) => `${task.id} ${task.title}`.toLowerCase().includes(needle));
  const selected = tasks.find((task) => task.id === value);
  return (
    <div className="min-w-0">
      <span id={labelId} className="text-xs text-fg-2">
        Ticket
      </span>
      <Dropdown
        menuClassName="w-72 max-w-[calc(100vw-24px)] overflow-hidden"
        trigger={(toggle) => (
          <button
            type="button"
            aria-labelledby={labelId}
            disabled={disabled}
            className={`${FIELD} mt-1 flex items-center gap-2 text-left`}
            title={selected ? `${value}: ${selected.title}` : value || "No ticket"}
            onClick={() => {
              setQuery("");
              toggle();
            }}
          >
            <span className="min-w-0 flex-1 truncate">
              {value || "No ticket"}
              {selected ? ` · ${selected.title}` : ""}
            </span>
            <ChevronDownIcon size={12} />
          </button>
        )}
      >
        {(close) => {
          const pick = (id: string) => {
            onChange(id);
            close();
          };
          return (
            <>
              <div className="px-2 py-1">
                <input
                  aria-label="Search tickets"
                  placeholder="Search tickets or enter an ID…"
                  className={FIELD}
                  autoComplete="off"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="max-h-56 overflow-auto">
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => pick("")}
                >
                  No ticket
                </button>
                {query.trim() && !tasks.some((task) => task.id.toLowerCase() === needle) && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => pick(query.trim())}
                  >
                    Use ticket {query.trim()}
                  </button>
                )}
                {matches.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => pick(task.id)}
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-xs">{task.id}</span>
                      <span className="block truncate text-xs text-muted-2">{task.title}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          );
        }}
      </Dropdown>
    </div>
  );
}
