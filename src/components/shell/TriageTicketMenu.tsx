/**
 * The right-click menu on a triage row: the ticket's Linear rows, then the one
 * thing triage does to a ticket without opening it — park it.
 *
 * Snoozing is a Linear write, so it follows the status picker's rule: always
 * offered, disabled with the read-only hint when the org can't be written to,
 * and refused by the backend either way (`repo_write_session`). Two wake-ups
 * are enough for a menu on a rail — tomorrow morning, and a week out; anything
 * finer is Linear's own picker. A snoozed row offers the reverse instead.
 */
import type { ReactNode } from "react";

import type { TriageTicket } from "../../bindings";
import {
  LINEAR_READ_ONLY_HINT,
  useLinearIssueUrl,
  useLinearReadOnly,
  useTriageSnooze,
} from "../../lib/queries";
import { snoozeUntil } from "../../lib/snooze";
import { SnoozeIcon } from "../icons";
import { linearTicketItems } from "../menuRows";
import { ContextMenu, type ContextMenuItem } from "../primitives";

export function TriageTicketMenu({
  repo,
  ticket,
  children,
}: {
  /** The repo whose Linear org the queue is read from — where the write goes. */
  repo: string;
  ticket: TriageTicket;
  children: ReactNode;
}) {
  const linkFor = useLinearIssueUrl(repo);
  const readOnly = useLinearReadOnly(repo);
  const snooze = useTriageSnooze(repo);
  const gate = readOnly ? { disabled: true, title: LINEAR_READ_ONLY_HINT } : {};
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
    ...linearTicketItems(ticket.id, linkFor(ticket.id)),
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
