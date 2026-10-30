/** A Web tab as every strip draws and opens it — the same in Trees, Reviews'
 *  checkout and Triage, so the three can't drift. */
import { type ReactNode, useMemo } from "react";

import type { WorktreeTab } from "../../bindings";
import { GlobeIcon } from "../../components/icons";
import { MENU_ITEM } from "../../components/primitives";
import type { StripTab } from "../../components/TabStrip";
import { openAmong, useWebHost, type WebHost } from "./hosts";
import type { pageLabel } from "./pageState";

/** A Web tab's strip entry: named by its page, marked with a globe. No rename —
 *  the page names it — and closing it needs no process torn down: its row going
 *  takes its page with it (`remove_worktree_tab`). */
export function webStripTab<T extends string>(
  tab: T,
  row: WorktreeTab,
  label: typeof pageLabel,
  onClose: () => void,
): StripTab<T> {
  return {
    tab,
    label: label(row.id, row.title, row.url),
    icon: <GlobeIcon size={11} className="text-muted-3" />,
    onClose,
  };
}

/** The "+" menu's Web row, disabled with the reason when it can't open. */
export function WebMenuRow({
  off,
  digit,
  onAdd,
}: {
  off: string | undefined;
  digit: number;
  onAdd: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={off !== undefined}
      title={off ?? "A web page, beside this workspace's agents"}
      onClick={onAdd}
      className={MENU_ITEM}
    >
      <GlobeIcon />
      Web
      <span className="ml-auto text-2xs text-muted-4">{digit}</span>
    </button>
  );
}

/** Register a strip as the place its surfaces' links and its Web tabs' popups
 *  open (`hosts`): a link goes to the tab already on its site, anything else to
 *  a new Web tab through `addWeb`. */
export function useStripWebHost({
  surfaces,
  rows,
  addWeb,
  closeTab,
  show,
}: {
  surfaces: readonly string[];
  rows: WorktreeTab[];
  addWeb: (url: string, opts?: { id?: string; background?: boolean }) => void;
  closeTab: (id: string) => void;
  show: (id: string) => void;
}) {
  const host = useMemo<WebHost>(
    () => ({
      open: (url, opts) => openAmong(rows, url, opts, { add: addWeb, show }),
      close: closeTab,
      activate: show,
    }),
    [rows, addWeb, closeTab, show],
  );
  useWebHost(
    host,
    surfaces,
    rows.filter((t) => t.kind === "web").map((t) => t.id),
  );
}
