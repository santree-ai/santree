/**
 * Pure grouping helpers for the Terminal tab: map live PTY sessions to the
 * ticket (and, from there, project) they belong to, and to a display label +
 * kind for the session tab strip. Sessions are identified by the orchestrator's
 * refId conventions:
 *
 *   - triage investigation:   source "triage", refId = "<ticketId>"
 *   - worktree main terminal: source "issue",  refId = "tree:<ticketId>"
 *   - worktree extra tab:     source "issue",  refId = "tree:<ticketId>:tab:<tabId>"
 *   - plain shell:            source "shell",  refId undefined
 */
import type { WorktreeTab } from "../../bindings";
import type { TerminalTab } from "./orchestrator";

/** The base-branch entry's sentinel ticket id (mirrors the Trees model's
 *  `BASE_ID` / Rust `worktree::BASE_ID` — duplicated here so the terminal
 *  feature doesn't reach into the Trees model). */
export const BASE_TICKET = "__base__";

/** What a live session is, parsed from its refId. */
export interface SessionRef {
  /** The ticket (issue id, or {@link BASE_TICKET}) it belongs to; null ⇒ a
   *  plain shell with no ticket. */
  ticket: string | null;
  /** The persisted extra tab's id (`worktree_tabs.id`) when it's one. */
  extraTabId: string | null;
  /** True for a triage investigation session. */
  investigation: boolean;
}

export function parseSessionRef(tab: TerminalTab): SessionRef {
  if (tab.source === "triage" && tab.refId) {
    return { ticket: tab.refId, extraTabId: null, investigation: true };
  }
  if (tab.source === "issue" && tab.refId?.startsWith("tree:")) {
    const rest = tab.refId.slice("tree:".length);
    const sep = rest.indexOf(":");
    if (sep === -1) return { ticket: rest, extraTabId: null, investigation: false };
    const tail = rest.slice(sep + 1);
    return {
      ticket: rest.slice(0, sep),
      extraTabId: tail.startsWith("tab:") ? tail.slice("tab:".length) : null,
      investigation: false,
    };
  }
  return { ticket: null, extraTabId: null, investigation: false };
}

/** A left-panel ticket item: every live session belonging to one ticket, in
 *  display order (main work terminal, extra tabs in open order, investigation). */
export interface TicketGroup {
  ticket: string;
  tabs: TerminalTab[];
}

/** Split the live sessions into plain shells and per-ticket groups. Groups keep
 *  first-opened order; within a group the main work terminal sorts first and the
 *  investigation last (`Array.sort` is stable, so open order holds within ranks). */
export function groupSessions(tabs: TerminalTab[]): {
  shells: TerminalTab[];
  tickets: TicketGroup[];
} {
  const shells: TerminalTab[] = [];
  const byTicket = new Map<string, TerminalTab[]>();
  for (const t of tabs) {
    const ref = parseSessionRef(t);
    if (!ref.ticket) {
      shells.push(t);
      continue;
    }
    const list = byTicket.get(ref.ticket) ?? [];
    list.push(t);
    byTicket.set(ref.ticket, list);
  }
  const rank = (t: TerminalTab) => {
    const ref = parseSessionRef(t);
    if (ref.investigation) return 2;
    return t.refId === `tree:${ref.ticket}` ? 0 : 1;
  };
  const tickets = [...byTicket.entries()].map(([ticket, list]) => ({
    ticket,
    tabs: list.slice().sort((a, b) => rank(a) - rank(b)),
  }));
  return { shells, tickets };
}

/** A sidebar section: one project (null ⇒ no project) and its ticket items. */
export interface ProjectSection {
  project: string | null;
  tickets: TicketGroup[];
}

/** Ticket ids are `<TEAM>-<n>`, so they must sort numerically on the number:
 *  plain lexicographic ordering puts AK-10 ahead of AK-9. */
const ticketOrder = new Intl.Collator(undefined, { numeric: true });

/** Bucket ticket groups into per-project sections: named projects first
 *  (alphabetically), the catch-all "no project" section last. Tickets keep
 *  their id order within a section. */
export function groupByProject(
  tickets: TicketGroup[],
  projectOf: (ticket: string) => string | null,
): ProjectSection[] {
  const byProject = new Map<string | null, TicketGroup[]>();
  for (const g of tickets) {
    const p = projectOf(g.ticket);
    const list = byProject.get(p) ?? [];
    list.push(g);
    byProject.set(p, list);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([project, groups]) => ({
      project,
      tickets: groups.slice().sort((a, b) => ticketOrder.compare(a.ticket, b.ticket)),
    }));
}

/** How a session should render in the tab strip. `work` is a ticket's main
 *  work terminal (agent-iconed unless it's the base entry's plain shell);
 *  `claude` is a persisted extra Claude tab; `shell` covers everything else. */
export type SessionKind = "investigation" | "work" | "claude" | "shell";

/** Display label + kind for one session. `extraRows` (the persisted
 *  `worktree_tabs` rows, keyed by id) supplies live titles for extra tabs so a
 *  rename shows here too — the PTY spec's title is frozen at open time. */
export function sessionMeta(
  tab: TerminalTab,
  extraRows: Map<string, WorktreeTab>,
): { label: string; kind: SessionKind } {
  const ref = parseSessionRef(tab);
  if (ref.investigation) return { label: "Investigation", kind: "investigation" };
  if (ref.extraTabId !== null) {
    const row = extraRows.get(ref.extraTabId);
    return {
      label: row?.title ?? tab.title,
      kind: row?.kind === "claude" ? "claude" : "shell",
    };
  }
  if (ref.ticket !== null && tab.refId === `tree:${ref.ticket}`) {
    return { label: "Terminal", kind: "work" };
  }
  return { label: tab.title, kind: "shell" };
}
