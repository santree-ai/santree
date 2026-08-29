/** "Start a task": create a worktree for one of the repo's startable issues
 *  (running setup per the Trees preference), picked from the tickets Linear says
 *  are ready.
 *
 *  The picker is the component; how it is summoned is the caller's. It renders a
 *  bare "+" by default and takes a `trigger` where the action needs a name — the
 *  welcome surface, where it is one of two things to do. */
import type { ReactNode } from "react";
import { useMemo } from "react";

import type { AgentKind, Task, Worktree } from "../../bindings";
import { PlusIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Dropdown, Spinner } from "../../components/primitives";
import { useCreateWorktree, useResolvedSetting, useTasks, WORK_AGENT_KEY } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { NO_PROJECT, useTrees } from "./model";

/** Startable issues with no worktree of their own. `pendingDeletes` has to be
 *  excluded explicitly: the Trees model already hides those worktrees optimistically,
 *  so a ticket mid-delete looks worktree-less here — offering it would race a fresh
 *  `create` against the `remove` still running on the same path. Exported for
 *  testing — see StartTaskButton.test.ts. */
export function startCandidates(
  tasks: Task[],
  worktrees: Worktree[],
  pendingDeletes: Set<string>,
): Task[] {
  const taken = new Set(worktrees.map((w) => w.id));
  return tasks.filter((t) => t.ready && !taken.has(t.id) && !pendingDeletes.has(t.id));
}

export function StartTaskButton({
  trigger,
}: {
  /** Render the opener. Handed the toggle and whether a create is in flight. */
  trigger?: (toggle: () => void, busy: boolean) => ReactNode;
} = {}) {
  const { repo, worktrees, startAgent } = useTrees();
  const { settings } = useApp();
  const { addPendingLaunches, removePendingLaunch, pendingDeletes } = useAppUi();
  const { data: tasks = [] } = useTasks(repo);
  const { data: workAgent } = useResolvedSetting(repo, WORK_AGENT_KEY);
  const { mutate: create, isPending } = useCreateWorktree(repo);

  const candidates = useMemo(
    () => startCandidates(tasks, worktrees, pendingDeletes),
    [tasks, worktrees, pendingDeletes],
  );

  // Mirrors the Issues tab's `launch()` (see features/issues/model.tsx): register
  // a pending launch *before* creating, so the Trees sidebar shows a "Creating
  // workspace…" placeholder at once (TreesProvider already merges `pendingLaunches`
  // into `worktrees`) rather than leaving the multi-second git worktree creation
  // with no feedback beyond the trigger button's tiny spinner. A failed create
  // drops the placeholder (the global mutation cache still surfaces the toast).
  const start = (t: { id: string; title: string; project: string }) => {
    const agent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
    const project = t.project === NO_PROJECT ? null : t.project;
    addPendingLaunches([{ id: t.id, title: t.title, project, agent }]);
    create(
      {
        issueId: t.id,
        title: t.title,
        project,
        // Only `ready` tickets are offered here (see `startCandidates`), and a
        // ready ticket has no unfinished blocker to stack on.
        stackOn: null,
        agent,
      },
      {
        // Open the new worktree and begin the task: run setup on the logs page
        // (per the preference), then launch the agent.
        onSuccess: (wt) => startAgent(wt.id),
        onError: () => removePendingLaunch(t.id),
      },
    );
  };

  return (
    <Dropdown
      menuClassName="w-72 max-h-80 overflow-y-auto"
      trigger={(toggle) =>
        trigger?.(toggle, isPending) ?? (
          <button
            type="button"
            onClick={toggle}
            disabled={isPending}
            title="Start a task in a new worktree"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-line-2 bg-input text-muted-2 hover:border-line-strong hover:text-fg-2 disabled:opacity-50"
          >
            {isPending ? <Spinner size={12} /> : <PlusIcon size={13} />}
          </button>
        )
      }
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
                <MarkdownTitle className="block line-clamp-2 text-[12px] text-fg-3">
                  {t.title}
                </MarkdownTitle>
              </button>
            ))
          )}
        </>
      )}
    </Dropdown>
  );
}
