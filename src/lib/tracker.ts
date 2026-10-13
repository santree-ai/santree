import type { LinearConnection, TicketProvider } from "../bindings";

/** A ticket detail's `trackerName` as the provider it names. A detail without
 *  one predates Jira, and every such detail was Linear's. */
export const trackerOf = (name: string | null | undefined): TicketProvider =>
  name === "Jira" || name === "TickTick" ? name : "Linear";

/** A TickTick ticket id, `<listId>.<taskId>` — the shape `ticktick::split_id`
 *  accepts, so the frontend and the backend agree on what is one. */
const TICKTICK_ID = /^([A-Za-z0-9]{1,64})\.([A-Za-z0-9]{1,64})$/;

/** A TickTick id's list and task, or `null` for any other tracker's id. */
export const splitTickTickId = (id: string): { list: string; task: string } | null => {
  const m = TICKTICK_ID.exec(id);
  return m ? { list: m[1], task: m[2] } : null;
};

/**
 * How a ticket id is shown to a person. Linear's and Jira's ids are already
 * handles (`ENG-142`, `OPS-7`); a TickTick id is two 24-character object ids, so
 * it reads as `tt-` and its task's last six characters — the handle its branch
 * carries too (`ticktick::handle`). Copying a ticket id still copies the id.
 */
export const ticketHandle = (id: string): string => {
  const tt = splitTickTickId(id);
  return tt ? `tt-${tt.task.slice(-6).toLowerCase()}` : id;
};

/** A TickTick task's page in the web app, or `null` when `id` isn't one. */
export const tickTickTaskUrl = (id: string): string | null => {
  const tt = splitTickTickId(id);
  return tt
    ? `https://ticktick.com/webapp/#p/${encodeURIComponent(tt.list)}/tasks/${encodeURIComponent(tt.task)}`
    : null;
};

/** What a repo's tracker connection can do, where the trackers — and Linear's
 *  two ways of connecting — differ. Views read this rather than checking
 *  `provider === "Jira"` or `via === "Mcp"` themselves, so another kind of
 *  connection is one entry here, not a check in every view. */
export interface TrackerFeatures {
  /** The tracker has a triage queue for the Triage section to read. */
  triage: boolean;
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
  if (provider === "TickTick") {
    // A to-do list: no snooze, flat comments, and no triage at all.
    return {
      triage: false,
      snoozeUnavailable: "TickTick tasks can't be snoozed from santree.",
      threadedComments: false,
      memberTeamsOnly: false,
    };
  }
  if (provider === "Jira") {
    // Jira has no snooze to write to, and its comments are flat.
    return {
      triage: true,
      snoozeUnavailable: "Jira tickets can't be snoozed from santree.",
      threadedComments: false,
      memberTeamsOnly: false,
    };
  }
  if (via === "Mcp") {
    // docs/linear-mcp.md: no snooze, and triage is the member teams only.
    return {
      triage: true,
      snoozeUnavailable:
        "Linear's MCP server can't snooze tickets. Connect the workspace through santree's OAuth app to snooze from santree.",
      threadedComments: true,
      memberTeamsOnly: true,
    };
  }
  return { triage: true, snoozeUnavailable: null, threadedComments: true, memberTeamsOnly: false };
}

/** A connected ticket tracker account. */
export interface Connection {
  /** `linear:<org slug>`, `jira:<cloud id>` or `ticktick:me` — what
   *  `Repo.connection` holds. */
  id: string;
  provider: TicketProvider;
  /** The workspace or site's own name. */
  name: string;
  /** `Linear · Acme`, for lists. */
  label: string;
}

/** How a connection is named wherever one is listed: the provider, then the
 *  workspace or site — the same spelling the backend gives `Repo.tracker`. */
export const connectionLabel = (provider: TicketProvider, name: string): string =>
  `${provider} · ${name}`;

/** The provider a connection id (`linear:<slug>`, `jira:<cloud id>`,
 *  `ticktick:me`) belongs to. */
export const connectionProvider = (id: string): TicketProvider | null => {
  const prefix = id.slice(0, id.indexOf(":"));
  return CONNECTION_PREFIX[prefix] ?? null;
};

const CONNECTION_PREFIX: Record<string, TicketProvider> = {
  linear: "Linear",
  jira: "Jira",
  ticktick: "TickTick",
};

/** The one TickTick account an install can connect (`connection.rs`). */
export const TICKTICK_CONNECTION = "ticktick:me";
