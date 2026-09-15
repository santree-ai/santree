/**
 * The right-click menu on a triage row: the ticket's tracker rows, then the one
 * thing triage does to a ticket without opening it — park it.
 *
 * Snoozing is a tracker write, so it follows the status picker's rule: always
 * offered, disabled with the read-only hint when the org can't be written to,
 * and refused by the backend either way. Where the connection has no snooze to
 * write to — Jira, a Linear org connected through its MCP server — the rows stay
 * but say why (`useTrackerFeatures`). Two wake-ups are enough for a menu on a rail —
 * tomorrow morning, and a week out; anything finer is the tracker's own picker.
 * A snoozed row offers the reverse instead.
 */
import type { ReactNode } from "react";

import type { TriageTicket } from "../../bindings";
import {
  TRACKER_READ_ONLY_HINT,
  useTicketIssueUrl,
  useTicketProvider,
  useTrackerFeatures,
  useTrackerReadOnly,
  useTriageSnooze,
} from "../../lib/queries";
import { snoozeUntil } from "../../lib/snooze";
import { SnoozeIcon } from "../icons";
import { ticketItems } from "../menuRows";
import { ContextMenu, type ContextMenuItem } from "../primitives";

export function TriageTicketMenu({
  repo,
  ticket,
  children,
}: {
  /** The repo whose tracker the queue is read from — where the write goes. */
  repo: string;
  ticket: TriageTicket;
  children: ReactNode;
}) {
  const linkFor = useTicketIssueUrl(repo);
  const provider = useTicketProvider(repo);
  const readOnly = useTrackerReadOnly(repo);
  const { snoozeUnavailable } = useTrackerFeatures(repo);
  const snooze = useTriageSnooze(repo);
  const gate = snoozeUnavailable
    ? { disabled: true, title: snoozeUnavailable }
    : readOnly
      ? { disabled: true, title: TRACKER_READ_ONLY_HINT }
      : {};
  const park = (untilMs: number | null) => snooze.mutate({ ticketId: ticket.id, untilMs });

  const parking: ContextMenuItem[] =
    ticket.snoozedUntilMs != null
      ? [
          {
            kind: "action",
            key: "wake",
            label: "Wake up now",
            icon: <SnoozeIcon size={12} />,
            ...gate,
            run: () => park(null),
          },
        ]
      : [
          {
            kind: "action",
            key: "snooze-tomorrow",
            label: "Snooze until tomorrow",
            icon: <SnoozeIcon size={12} />,
            ...gate,
            run: () => park(snoozeUntil(Date.now(), 1)),
          },
          {
            kind: "action",
            key: "snooze-week",
            label: "Snooze for a week",
            icon: <SnoozeIcon size={12} />,
            ...gate,
            run: () => park(snoozeUntil(Date.now(), 7)),
          },
        ];

  const items: ContextMenuItem[] = [
    ...ticketItems(ticket.id, linkFor(ticket.id), provider),
    { kind: "rule", key: "rule-snooze" },
    ...parking,
  ];

  // `contents`: no box of its own, so the card keeps its margins and lays out
  // exactly as it did without a menu.
  return (
    <ContextMenu items={items} className="contents">
      {children}
    </ContextMenu>
  );
}
