/** "Take me to this agent" — the Agents panel's one navigation action. */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useApp, useAppUi } from "../../state/AppContext";
import type { AgentEntry } from "./registry";

/**
 * Open the surface that owns an agent, switching repos first when it belongs to
 * another one (every other view is scoped to the active repo, so navigating
 * without switching would land on a view that doesn't contain it).
 *
 * The focus handoffs (`requestTreeFocus` / `requestTriageFocus`) are the app's
 * existing cross-view pattern: set the target, navigate, the destination selects
 * it on mount and consumes the request.
 */
export function useOpenAgent(): (entry: AgentEntry) => void {
  const navigate = useNavigate();
  const { activeRepo, setActiveRepo } = useApp();
  const { requestTreeFocus, requestTriageFocus, requestReviewFocus } = useAppUi();

  return useCallback(
    (entry: AgentEntry) => {
      if (entry.repo && entry.repo !== activeRepo) setActiveRepo(entry.repo);

      switch (entry.origin.kind) {
        case "tree":
        case "tree-tab":
          // Selects the worktree; an extra tab's own sub-tab isn't addressable
          // cross-view, so it lands on the worktree and its last-used tab.
          if (entry.origin.ticket) requestTreeFocus(entry.origin.ticket);
          navigate({ to: "/trees" });
          return;
        case "triage":
          if (entry.origin.ticket) requestTriageFocus(entry.origin.ticket);
          navigate({ to: "/triage" });
          return;
        case "review":
        case "ai-review":
          // Reviews selects a PR by its URL (the same handoff a PR pill uses).
          // Which of the two sessions it is isn't addressable cross-view, so this
          // lands on the PR and its last-used tab.
          if (entry.origin.pr) {
            const [repo, number] = entry.origin.pr.split("#");
            if (repo && number) requestReviewFocus(`https://github.com/${repo}/pull/${number}`);
          }
          navigate({ to: "/reviews" });
          return;
        case "dev":
          navigate({ to: "/dev" });
          return;
        default:
        // Nothing owns it, so there is nowhere to go. Entries in this state
        // carry `openable: false` and their action is disabled, so this is
        // unreachable from the UI — it stays exhaustive rather than silent.
      }
    },
    [navigate, activeRepo, setActiveRepo, requestTreeFocus, requestTriageFocus, requestReviewFocus],
  );
}
