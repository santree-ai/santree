/** "Take me to this agent" — shared by every surface that lists sessions. */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { AgentKind } from "../../bindings";
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
  /** The provider running the session — which of a ticket's investigation tabs
   *  to land on. `null` when santree cannot name it; the surface then opens on
   *  its default tab rather than on a guess. */
  agentKind: AgentKind | null;
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
          // Name the tab the session actually lives in. Dropping it is why every
          // agent used to land on tab one — including a Codex tab whose row you
          // clicked. `tabId` is null only for a `tree` origin, a session minted
          // before every agent lived in a tab: there is no tab to name, so this
          // selects the worktree and leaves whatever it had open. The pane is
          // deliberately left unnamed too: opening an agent says nothing about
          // which right-panel pane you wanted, and forcing one is how a click in
          // the History pane used to jump you to the ticket.
          if (entry.origin.ticket) {
            requestTreeFocus(entry.origin.ticket, { tab: entry.origin.tabId });
          }
          navigate({ to: "/trees" });
          return;
        case "triage":
          if (!entry.origin.ticket) {
            navigate({ to: "/triage" });
            return;
          }
          // The focus names only the tab. The ticket rides in the route so the
          // sidebar's Triage row lights on arrival rather than a frame later —
          // the same reason the review case below puts the PR in the url.
          requestTriageFocus(entry.origin.ticket, entry.agentKind ?? undefined);
          navigate({ to: "/triage", search: { ticket: entry.origin.ticket } });
          return;
        case "review":
        case "ai-review": {
          // Reviews selects a PR by its URL (the same handoff a PR pill uses).
          // Which of the two sessions it is isn't addressable cross-view, so this
          // lands on the PR and its last-used tab.
          const [prRepo, number] = entry.origin.pr?.split("#") ?? [];
          const url = prRepo && number ? `https://github.com/${prRepo}/pull/${number}` : undefined;
          if (url) requestReviewFocus(url);
          // Reviews narrows to one registered project, so the session's own
          // project has to ride along or the PR lands in an inbox without it.
          // The PR rides in the route as well as in the focus request, so the
          // sidebar lights its row on arrival rather than a frame later — the
          // same reason `useOpenPr` puts it there.
          navigate({ to: "/reviews", search: { project: entry.repo ?? undefined, pr: url } });
          return;
        }
        default:
        // Nothing owns it, so there is nowhere to go. Registry entries in this
        // state carry `openable: false` and their action is disabled, so this is
        // unreachable from the UI — it stays exhaustive rather than silent.
      }
    },
    [navigate, activeRepo, setActiveRepo, requestTreeFocus, requestTriageFocus, requestReviewFocus],
  );
}
