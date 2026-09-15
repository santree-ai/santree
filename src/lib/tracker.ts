import type { LinearConnection, TicketProvider } from "../bindings";

/** A ticket detail's `trackerName` as the provider it names. A detail without
 *  one predates Jira, and every such detail was Linear's. */
export const trackerOf = (name: string | null | undefined): TicketProvider =>
  name === "Jira" ? "Jira" : "Linear";

/** What a repo's tracker connection can do, where the trackers — and Linear's
 *  two ways of connecting — differ. Views read this rather than checking
 *  `provider === "Jira"` or `via === "Mcp"` themselves, so another kind of
 *  connection is one entry here, not a check in every view. */
export interface TrackerFeatures {
  /** Why tickets can't be snoozed from santree, or `null` when they can. */
  snoozeUnavailable: string | null;
  /** Comments carry threads, so each one offers a Reply. */
  threadedComments: boolean;
  /** Triage reads only the teams you are a member of: the rotation, assigned
   *  and "Always show" team rules don't apply, and "Never show" still does. */
  memberTeamsOnly: boolean;
}

export function trackerFeatures(
  provider: TicketProvider,
  via: LinearConnection | null | undefined,
): TrackerFeatures {
  if (provider === "Jira") {
    // Jira has no snooze to write to, and its comments are flat.
    return {
      snoozeUnavailable: "Jira tickets can't be snoozed from santree.",
      threadedComments: false,
      memberTeamsOnly: false,
    };
  }
  if (via === "Mcp") {
    // docs/linear-mcp.md: no snooze, and triage is the member teams only.
    return {
      snoozeUnavailable:
        "Linear's MCP server can't snooze tickets. Connect the workspace through santree's OAuth app to snooze from santree.",
      threadedComments: true,
      memberTeamsOnly: true,
    };
  }
  return { snoozeUnavailable: null, threadedComments: true, memberTeamsOnly: false };
}
