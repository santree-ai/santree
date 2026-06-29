/** "Start a task": create a worktree for one of the repo's startable issues
 *  (running setup per the Trees preference). The minimal start-task entry point
 *  in the Trees sidebar. */
import { useMemo } from "react";

import { PlusIcon } from "../../components/icons";
import { Dropdown, Spinner } from "../../components/primitives";
import { useCreateWorktree, useTasks } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { NO_PROJECT, useTrees } from "./model";

export function StartTaskButton() {
  const { repo, worktrees, startAgent } = useTrees();
  const { settings } = useApp();
  const { data: tasks = [] } = useTasks(repo);
  const { mutate: create, isPending } = useCreateWorktree(repo);

  // Startable issues that don't already have a worktree.
  const candidates = useMemo(() => {
    const taken = new Set(worktrees.map((w) => w.id));
    return tasks.filter((t) => t.ready && !taken.has(t.id));
  }, [tasks, worktrees]);

  const start = (t: { id: string; title: string; project: string }) =>
    create(
      {
        issueId: t.id,
        title: t.title,
        project: t.project === NO_PROJECT ? null : t.project,
        base: null,
        // Setup runs in the worktree terminal (so its logs stream), not here.
        runSetup: false,
        agent: settings?.defaultAgent ?? "Claude",
      },
      {
        // Open the new worktree and begin the task: run setup on the logs page
        // (per the preference), then launch the agent.
        onSuccess: (wt) => startAgent(wt.id),
      },
    );

  return (
    <Dropdown
      menuClassName="w-72 max-h-80 overflow-y-auto"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          disabled={isPending}
          title="Start a task in a new worktree"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-line-2 bg-input text-muted-2 hover:border-line-strong hover:text-fg-2 disabled:opacity-50"
        >
          {isPending ? <Spinner size={12} /> : <PlusIcon size={13} />}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-3 py-1.5 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
            Start a task
          </div>
          {candidates.length === 0 ? (
            <div className="px-3 py-3 text-[11.5px] text-muted-3">
              No startable issues without a worktree.
            </div>
          ) : (
            candidates.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => {
                  start(t);
                  close();
                }}
                className="flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-hover"
              >
                <span className="font-mono text-[10.5px] text-muted-2">{t.id}</span>
                <span className="line-clamp-1 text-[12px] text-fg-3">{t.title}</span>
              </button>
            ))
          )}
        </>
      )}
    </Dropdown>
  );
}
