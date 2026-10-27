/** Which tab strip a Web tab — or a surface's link — belongs to.
 *
 *  Three strips hold Web tabs (Trees, Reviews' checkout, Triage), each over its
 *  own tab rows. Some of what happens to a page starts outside any of them: the
 *  page opens a popup or closes itself (backend events, by tab id), a terminal
 *  prints a link (by the surface the terminal is on). Each strip registers what
 *  it shows here, and those land on it. */
import { useEffect } from "react";

import { commands, type WorktreeTab } from "../../bindings";
import { pageState } from "./pageState";

export interface WebHost {
  /** Open `url` on this surface: in the Web tab already on that site, or in a
   *  new one. `id` names the new tab (the page may already exist under it);
   *  `background` leaves it behind the current tab. */
  open: (url: string, opts?: { id?: string; background?: boolean }) => void;
  /** Close a Web tab of this surface (its page closed itself). */
  close: (tabId: string) => void;
  /** Bring a Web tab's split group forward (the user clicked into its page). */
  activate: (tabId: string) => void;
}

const bySurface = new Map<string, WebHost>();
const byTab = new Map<string, WebHost>();

/** Register `host` for the surfaces it shows (the rows' owner — a worktree id or
 *  `triage:<ticket>` — plus any terminal surface whose links it takes) and the
 *  Web tabs among its rows, while mounted. */
export function useWebHost(host: WebHost, surfaces: readonly string[], tabIds: readonly string[]) {
  const surfaceKey = surfaces.join("\n");
  const tabKey = tabIds.join("\n");
  useEffect(() => {
    const owned = {
      surfaces: surfaceKey.split("\n").filter(Boolean),
      tabs: tabKey.split("\n").filter(Boolean),
    };
    for (const s of owned.surfaces) bySurface.set(s, host);
    for (const t of owned.tabs) byTab.set(t, host);
    return () => {
      for (const s of owned.surfaces) if (bySurface.get(s) === host) bySurface.delete(s);
      for (const t of owned.tabs) if (byTab.get(t) === host) byTab.delete(t);
    };
  }, [host, surfaceKey, tabKey]);
}

/** The strip showing `surface`, if one is on screen. */
export const hostOfSurface = (surface: string): WebHost | undefined => bySurface.get(surface);

/** The strip holding Web tab `tabId`, if one is on screen. */
export const hostOfTab = (tabId: string): WebHost | undefined => byTab.get(tabId);

/** {@link WebHost.open} over a strip's rows: a link goes to the Web tab already
 *  showing that site — so clicking a dev server's address again lands on the tab
 *  it is in, not a new one — and anything else to a new tab through `add`. A
 *  page's own popup (`opts.id`) always gets a tab of its own. */
export function openAmong(
  rows: WorktreeTab[],
  url: string,
  opts: { id?: string; background?: boolean } | undefined,
  {
    add,
    show,
  }: {
    add: (url: string, opts?: { id?: string; background?: boolean }) => void;
    show: (id: string) => void;
  },
) {
  if (!opts?.id) {
    const site = originOf(url);
    const same = site !== null && rows.find((t) => t.kind === "web" && siteOf(t) === site);
    if (same) {
      show(same.id);
      void commands.browserLoad(same.id, url);
      return;
    }
  }
  add(url, opts);
}

/** The site a Web tab is on. A page that didn't open is still on the site it
 *  tried — a dev server not up yet — and a tab restored from the last session,
 *  not shown since, is on its row's. */
function siteOf(row: WorktreeTab): string | null {
  const state = pageState(row.id);
  if (state?.crashed) return null;
  return originOf((state ? state.failure?.url || state.url : row.url) ?? "");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
