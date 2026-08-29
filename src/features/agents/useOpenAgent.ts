/** "Take me to this agent" — shared by every surface that lists sessions. */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useApp, useAppUi } from "../../state/AppContext";
import type { AgentOrigin } from "./registry";

/**
 * Open the surface that owns an agent, switching repos first when it belongs to
 * another one (every other view is scoped to the active repo, so navigating
 * without switching would land on a view that doesn't contain it).
 *
 * The focus handoffs (`requestTreeFocus` / `requestTriageFocus`) are the app's
 * existing cross-view pattern: set the target, navigate, the destination selects
 * it on mount and consumes the request.
 *
 * Takes only what it navigates by, not a whole `AgentEntry`: the command palette
 * lists raw session rows and would otherwise have to reproduce this switch.
 */
export interface AgentTarget {
  repo: string | null;
  origin: AgentOrigin;
}

export function useOpenAgent(): (entry: AgentTarget) => void {
  const navigate = useNavigate();
  const { activeRepo, setActiveRepo } = useApp();
  const { requestTreeFocus, requestTriageFocus, requestReviewFocus } = useAppUi();

  return useCallback(
    (entry: AgentTarget) => {
      if (entry.repo && entry.repo !== activeRepo) setActiveRepo(entry.repo);

      switch (entry.origin.kind) {
        case "tree":
        case "tree-tab":
          // Name the tab the session actually lives in: `tabId` is null for a
          // `tree` origin, which IS the main work terminal, and the extra tab's
          // id for a `tree-tab` one. Dropping it is why every agent used to land
          // on tab one — including a Codex tab whose row you clicked. The pane is
          // deliberately left unnamed: opening an agent says nothing about which
          // right-panel pane you wanted, and forcing one is how a click in the
          // History pane used to jump you to the ticket.
          if (entry.origin.ticket) {
            requestTreeFocus(entry.origin.ticket, { tab: entry.origin.tabId });
          }
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
        default:
        // Nothing owns it, so there is nowhere to go. Registry entries in this
        // state carry `openable: false` and their action is disabled, so this is
        // unreachable from the UI — it stays exhaustive rather than silent.
      }
    },
    [navigate, activeRepo, setActiveRepo, requestTreeFocus, requestTriageFocus, requestReviewFocus],
  );
}
