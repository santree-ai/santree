/** "Start a task": create a worktree for one of the startable issues Linear says
 *  are ready, running setup per the Trees preference.
 *
 *  Where it lands is the Work gate's answer, not this button's. The tickets it
 *  offers belong to a Linear org, and several registered projects routinely
 *  resolve to one org — so "the project I am looking at" was never an answer to
 *  "where does this run", and using it as one is how a canary ticket came to be
 *  started in the santree checkout. This is also the surface with the least
 *  claim to one: it is Trees' welcome state, shown precisely when no project is
 *  open.
 *
 *  The picker is the component; how it is summoned is the caller's. It renders a
 *  bare "+" by default and takes a `trigger` where the action needs a name — the
 *  welcome surface, where it is one of two things to do. */
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMemo } from "react";

import type { AgentKind, Task, Worktree } from "../../bindings";
import { PlusIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Dropdown, Spinner } from "../../components/primitives";
import {
  useCreateWorktree,
  useOrgSiblings,
  useResolvedSetting,
  useTasks,
  useWorkScopeRepo,
  WORK_AGENT_KEY,
} from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { useWorkRepoGate } from "../../state/WorkRepoGate";
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
  const { worktrees } = useTrees();
  const { settings } = useApp();
  const navigate = useNavigate();
  const { addPendingLaunches, removePendingLaunch, requestTreeLaunch, pendingDeletes } = useAppUi();
  // Read scope: which tickets there are to offer. With a project open it is that
  // project's org; with none — the welcome surface — the Work default's. Either
  // way it names an org, never a destination.
  const scopeRepo = useWorkScopeRepo();
  const targets = useOrgSiblings(scopeRepo);
  const askRepo = useWorkRepoGate();
  const { data: tasks = [] } = useTasks(scopeRepo);
  const { data: workAgent } = useResolvedSetting(scopeRepo, WORK_AGENT_KEY);
  const { mutate: create, isPending } = useCreateWorktree();

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
    void askRepo(targets, `Starting ${t.id}`).then((repo) => {
      if (!repo) return;
      const agent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
      const project = t.project === NO_PROJECT ? null : t.project;
      addPendingLaunches([{ repo, id: t.id, title: t.title, project, agent }]);
      requestTreeLaunch(t.id);
      // Open the workspace the ticket is landing in before the create resolves —
      // it may not be the one on screen, and the pending row is there waiting.
      navigate({ to: "/trees", search: { project: repo, tree: t.id } });
      create(
        {
          repo,
          issueId: t.id,
          title: t.title,
          launch: { type: "ticket", project },
          // Only `ready` tickets are offered here (see `startCandidates`), and a
          // ready ticket has no unfinished blocker to stack on.
          base: null,
          agent,
        },
        {
          // Begin the task through the launch channel rather than by calling the
          // workspace's own `startAgent`: the create resolves after the
          // navigation, and a `startAgent` captured at the click belongs to
          // whichever project was open *then* — it would mint the tab row in the
          // wrong one. The channel is read by whichever workspace is mounted,
          // which by now is the ticket's.
          onError: () => removePendingLaunch(t.id),
        },
      );
    });
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
