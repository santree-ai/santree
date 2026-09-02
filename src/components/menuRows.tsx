/**
 * Rows that more than one right-click menu carries, so an object is the same
 * object wherever it is right-clicked.
 *
 * A ticket's three — where it lives in Linear, and its id and link for pasting
 * — are shared by the Tickets list, the graph's nodes and the sidebar's triage
 * rows. `url` is null until the repo's Linear org is known (`useLinearIssueUrl`);
 * the two rows that need it wait as disabled rows rather than vanishing, so a
 * menu doesn't change shape under the pointer.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "../state/toast";
import { CopyIcon, LinearLogo, LinkIcon } from "./icons";
import type { ContextMenuItem } from "./primitives";

/** Put `text` on the clipboard and say so — one wording for every copy row. */
export function copyText(text: string, what: string) {
  void navigator.clipboard.writeText(text);
  toast.success(`${what} copied.`);
}

export function linearTicketItems(id: string, url: string | null): ContextMenuItem[] {
  return [
    {
      kind: "action",
      key: "open-linear",
      label: "Open in Linear",
      icon: <LinearLogo size={12} />,
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
