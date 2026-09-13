/**
 * Rows that more than one right-click menu carries, so an object is the same
 * object wherever it is right-clicked.
 *
 * A ticket's three — where it lives in its tracker, and its id and link for
 * pasting — are shared by the Tickets list, the graph's nodes and the sidebar's
 * triage rows. `url` is null until the repo's org or site is known
 * (`useTicketIssueUrl`); the two rows that need it wait as disabled rows rather
 * than vanishing, so a menu doesn't change shape under the pointer.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import type { TicketProvider } from "../bindings";
import { toast } from "../state/toast";
import { CopyIcon, LinkIcon, TrackerLogo } from "./icons";
import type { ContextMenuItem } from "./primitives";

/** Put `text` on the clipboard and say so — one wording for every copy row. */
export function copyText(text: string, what: string) {
  void navigator.clipboard.writeText(text);
  toast.success(`${what} copied.`);
}

export function ticketItems(
  id: string,
  url: string | null,
  provider: TicketProvider,
): ContextMenuItem[] {
  return [
    {
      kind: "action",
      key: "open-tracker",
      label: `Open in ${provider}`,
      icon: <TrackerLogo provider={provider} size={12} />,
      disabled: url === null,
      run: () => {
        if (url) void openUrl(url);
      },
    },
    {
      kind: "action",
      key: "copy-id",
      label: "Copy ticket id",
      icon: <CopyIcon size={13} />,
      run: () => copyText(id, "Ticket id"),
    },
    {
      kind: "action",
      key: "copy-link",
      label: "Copy link",
      icon: <LinkIcon size={13} />,
      disabled: url === null,
      run: () => {
        if (url) copyText(url, "Link");
      },
    },
  ];
}
