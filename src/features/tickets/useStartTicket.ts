/**
 * Starting a ticket from the cross-repo list.
 *
 * The launch itself is the established one — register a pending launch so Trees
 * shows "Creating workspace…" immediately, create the worktree, then let Trees
 * start the agent (`requestTreeLaunch`) or spawn it off-screen
 * (`requestBackgroundLaunch`, the ⌘-click path).
 *
 * What this used to add was a repo hop: `createWorktree` was bound to the app's
 * active project, so a start elsewhere had to switch the whole app and park the
 * launch for a render until the mutation was re-bound. There is no active
 * project any more — the target rides in the create's own vars, and the caller
 * (`TicketsList`, through the Work gate) has already decided it.
 *
 * Only startable tickets are offered (see `isStartable`), which is what keeps
 * this path dialog-free: the launch's two questions — run the setup script, and
 * branch off a blocker's work — are only ever asked for a batch or for a ticket
 * that would stack, and this asks for neither.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { AgentKind } from "../../bindings";
import { ensureResolvedSetting, useCreateWorktree, WORK_AGENT_KEY } from "../../lib/queries";
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

/**
 * Start a ticket's worktree and agent. `background` (⌘-click) keeps the current
 * view and starts the agent off-screen instead of navigating to Trees.
 */
export function useStartTicket(): (target: StartTarget, opts?: { background?: boolean }) => void {
  const { settings } = useApp();
  const {
    addPendingLaunches,
    removePendingLaunch,
    requestTreeLaunch,
    requestBackgroundLaunch,
    clearBackgroundLaunch,
  } = useAppUi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { mutate: create } = useCreateWorktree();

  // The Work agent can be overridden per project, and which project this is is
  // only known at the click — so it is resolved imperatively (cache-first, the
  // same shape `AgentRuns.beginRun` uses for the setup preference) rather than
  // by a hook bound to a project this doesn't have yet.
  const start = useCallback(
    (target: StartTarget, background: boolean, agent: AgentKind) => {
      const project = target.project === NO_PROJECT ? null : target.project;
      addPendingLaunches([
        { repo: target.repo, id: target.id, title: target.title, project, agent },
      ]);
      // Hand the launch to Trees before the git create resolves — the placeholder
      // is what makes the multi-second create feel immediate.
      if (background) {
        requestBackgroundLaunch(target.repo, target.id);
        toast.success(`Running ${target.id} in the background…`);
      } else {
        requestTreeLaunch(target.id);
        navigate({ to: "/trees", search: { project: target.repo, tree: target.id } });
      }
      create(
        {
          repo: target.repo,
          issueId: target.id,
          title: target.title,
          launch: { type: "ticket", project },
          // Startable tickets have no unfinished blocker to stack on.
          base: null,
          agent,
          quiet: background,
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
      create,
      addPendingLaunches,
      removePendingLaunch,
      requestTreeLaunch,
      requestBackgroundLaunch,
      clearBackgroundLaunch,
      navigate,
    ],
  );

  return useCallback(
    (target, opts) => {
      const fallback = settings?.defaultAgent ?? "Claude";
      const background = opts?.background ?? false;
      void ensureResolvedSetting(qc, target.repo, WORK_AGENT_KEY).then(
        (value) => start(target, background, (value as AgentKind | null) ?? fallback),
        // A failed settings read must never swallow the launch.
        () => start(target, background, fallback),
      );
    },
    [qc, settings, start],
  );
}
