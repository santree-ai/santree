/** What each Web tab's page is doing — its address, title, loading — as the
 *  backend pushes it (`BrowserChanged`). An external store rather than query
 *  data: it is a live feed, and a tab strip far from the page reads it for the
 *  tab's label. */
import { useSyncExternalStore } from "react";

import type { BrowserState } from "../../bindings";

const states = new Map<string, BrowserState>();
const listeners = new Set<() => void>();
/** Bumped on every change, for readers of many pages at once (a tab strip). */
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record a page's new state. WebKit clears a page's title while it navigates,
 *  so the last one is kept until the next page names itself — or the tab's
 *  label would flash its address on every click. */
export function setPageState(next: BrowserState) {
  const prev = states.get(next.id);
  const title = next.title || (next.loading && prev ? prev.title : "");
  states.set(next.id, { ...next, title });
  version++;
  for (const listener of listeners) listener();
}

/** {@link pageLabel}, re-rendering the caller whenever any page changes — for a
 *  tab strip, which labels every Web tab it shows. */
export function usePageLabels(): typeof pageLabel {
  useSyncExternalStore(subscribe, () => version);
  return pageLabel;
}

export function pageState(id: string): BrowserState | undefined {
  return states.get(id);
}

/** A tab's page state, re-rendering on every change to it. */
export function usePageState(id: string): BrowserState | undefined {
  return useSyncExternalStore(subscribe, () => states.get(id));
}

/** What a Web tab is called: its page's title, else its host, else the title the
 *  tab was stored with (the page's, the last time it loaded). An address that
 *  didn't open names the tab by its host: the title is the page's behind it. */
export function pageLabel(id: string, stored: string, url: string | null): string {
  const state = states.get(id);
  if (state?.title && !state.failure) return state.title;
  const address = state?.failure?.url || state?.url || url;
  if (address) {
    try {
      return new URL(address).host || stored;
    } catch {
      return stored;
    }
  }
  return stored;
}
