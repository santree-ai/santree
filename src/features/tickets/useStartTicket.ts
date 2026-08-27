/**
 * Starting a ticket from the cross-repo list.
 *
 * The launch itself is the established one — register a pending launch so Trees
 * shows "Creating workspace…" immediately, create the worktree, then let Trees
 * start the agent (`requestTreeLaunch`) or spawn it off-screen
 * (`requestBackgroundLaunch`, the ⌘-click path). What this page adds is the repo
 * hop: `createWorktree` is bound to the active repo, and a ticket here can
 * belong to any of them, so a start on a foreign repo switches the app to it
 * first and runs one render later, once the mutation is bound to the right repo.
 *
 * Only startable tickets are offered (see `isStartable`), which is what keeps
 * this path dialog-free: the launch's two questions — run the setup script, and
 * branch off a blocker's work — are only ever asked for a batch or for a ticket
 * that would stack, and this asks for neither.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import type { AgentKind } from "../../bindings";
import { useCreateWorktree, useResolvedSetting, WORK_AGENT_KEY } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { NO_PROJECT } from "../trees/model";

/** A ticket to start, identified across repos. */
export interface StartTarget {
  repo: string;
  id: string;
  title: string;
  project: string;
}

interface PendingStart extends StartTarget {
  background: boolean;
}

/**
 * Start a ticket's worktree and agent. `background` (⌘-click) keeps the current
 * view and starts the agent off-screen instead of navigating to Trees.
 */
export function useStartTicket(): (target: StartTarget, opts?: { background?: boolean }) => void {
  const { activeRepo, setActiveRepo, settings } = useApp();
  const {
    addPendingLaunches,
    removePendingLaunch,
    requestTreeLaunch,
    requestBackgroundLaunch,
    clearBackgroundLaunch,
  } = useAppUi();
  const navigate = useNavigate();
  const { data: workAgent } = useResolvedSetting(activeRepo, WORK_AGENT_KEY);
  const { mutate: create } = useCreateWorktree(activeRepo);

  const [parked, setParked] = useState<PendingStart | null>(null);

  const run = useCallback(
    (target: PendingStart) => {
      const agent = (workAgent as AgentKind | null) ?? settings?.defaultAgent ?? "Claude";
      const project = target.project === NO_PROJECT ? null : target.project;
      addPendingLaunches([{ id: target.id, title: target.title, project, agent }]);
      // Hand the launch to Trees before the git create resolves — the placeholder
      // is what makes the multi-second create feel immediate.
      if (target.background) {
        requestBackgroundLaunch(target.id);
        toast.success(`Running ${target.id} in the background…`);
      } else {
        requestTreeLaunch(target.id);
        navigate({ to: "/trees" });
      }
      create(
        {
          issueId: target.id,
          title: target.title,
          project,
          // Startable tickets have no unfinished blocker to stack on.
          stackOn: null,
          agent,
          quiet: target.background,
        },
        {
          onError: () => {
            removePendingLaunch(target.id);
            clearBackgroundLaunch(target.id);
          },
        },
      );
    },
    [
      workAgent,
      settings,
      create,
      addPendingLaunches,
      removePendingLaunch,
      requestTreeLaunch,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      navigate,
    ],
  );

  // The parked launch fires as soon as the repo switch has landed, so `create`
  // (and the resolved Work agent) belong to the ticket's own repo.
  useEffect(() => {
    if (!parked || parked.repo !== activeRepo) return;
    setParked(null);
    run(parked);
  }, [parked, activeRepo, run]);

  return useCallback(
    (target, opts) => {
      const pending: PendingStart = { ...target, background: opts?.background ?? false };
      if (target.repo === activeRepo) {
        run(pending);
        return;
      }
      setActiveRepo(target.repo);
      setParked(pending);
    },
    [activeRepo, run, setActiveRepo],
  );
}
