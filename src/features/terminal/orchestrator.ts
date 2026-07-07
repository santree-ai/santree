/**
 * The app's terminal orchestration API — strictly placement + seeding, nothing
 * more (see COMPLIANCE.md). It tracks open sessions as tabs and can open a new
 * one for a given cwd/command, optionally with a single human-initiated seed
 * prompt. It does NOT parse output, drive the CLI, or touch credentials.
 */
import { useCallback, useMemo, useRef, useState } from "react";

/** Where a terminal was opened from — drives the grouping in the Terminal tab. */
export type TerminalSource = "shell" | "triage" | "issue";

/** Height (px) of the Terminal tab's session tab strip. The strip is rendered
 *  by `TerminalSurface` with `CHROME.subBar` (h-9 = 36px); `TerminalLayer`
 *  offsets its full-area overlay by the same amount so the strip stays visible
 *  above the terminals. Keep the two in sync. */
export const TERMINAL_STRIP_PX = 36;

/** A terminal to open: a cwd + command (empty ⇒ login shell), optional seed. */
export interface TerminalSpec {
  title: string;
  cwd?: string;
  /** Empty ⇒ the user's login shell. */
  command?: string;
  args?: string[];
  /** One-time initial input, sent as if the user typed it. */
  seed?: string;
  /** Category, for grouping (defaults to "shell"). */
  source?: TerminalSource;
  /** When opened for a ticket/issue, its id — lets callers find/reuse the session. */
  refId?: string;
}

export interface TerminalTab extends TerminalSpec {
  /** Stable React key + identity for the tab's lifetime. */
  key: string;
  source: TerminalSource;
}

let seq = 0;
const withKey = (spec: TerminalSpec): TerminalTab => ({
  ...spec,
  source: spec.source ?? "shell",
  key: `term-${seq++}`,
});

/** A viewport rectangle (subset of DOMRect) the embed layer positions over. */
export interface EmbedRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** A session displayed inline somewhere other than the Terminal tab. */
export interface TerminalEmbed {
  host: HTMLElement;
  key: string;
  /** Host rect measured at embed time, so the layer is sized correctly on the
   * first render (before the live ResizeObserver re-measures) — this prevents the
   * terminal from briefly opening at the wrong size. */
  rect?: EmbedRect;
}

export interface TerminalTabs {
  tabs: TerminalTab[];
  activeKey: string | null;
  setActiveKey: (key: string) => void;
  /** Open a new terminal tab and focus it; returns its key. */
  open: (spec: TerminalSpec) => string;
  /** Open a session for `refId` if one doesn't exist yet; returns its key. */
  ensure: (spec: TerminalSpec & { refId: string }) => string;
  /** Close a tab (the view tears its session down on unmount). */
  close: (key: string) => void;
  /** The session currently embedded inline (e.g. the triage Investigate tab). */
  embed: TerminalEmbed | null;
  setEmbed: (embed: TerminalEmbed | null) => void;
}

export function useTerminalTabs(initial: TerminalSpec[] = []): TerminalTabs {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => initial.map(withKey));
  const [activeKey, setActiveKey] = useState<string | null>(tabs[0]?.key ?? null);
  const [embed, setEmbed] = useState<TerminalEmbed | null>(null);
  // Mirror the latest tabs so `ensure` can decide without an impure (StrictMode
  // double-invoked) state updater.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const open = useCallback((spec: TerminalSpec) => {
    const tab = withKey(spec);
    setTabs((prev) => [...prev, tab]);
    setActiveKey(tab.key);
    return tab.key;
  }, []);

  // Reuse an existing session for the same (source, refId) so re-entering an
  // issue's Investigate tab attaches to its live shell instead of spawning a new
  // one. Returns the existing or newly-created key.
  const ensure = useCallback((spec: TerminalSpec & { refId: string }) => {
    const source = spec.source ?? "shell";
    const found = tabsRef.current.find((t) => t.source === source && t.refId === spec.refId);
    if (found) return found.key;
    const tab = withKey(spec);
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((prev) => [...prev, tab]);
    return tab.key;
  }, []);

  const close = useCallback((key: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      const next = prev.filter((t) => t.key !== key);
      setActiveKey((cur) => (cur === key ? (next[Math.max(0, idx - 1)]?.key ?? null) : cur));
      return next;
    });
  }, []);

  return useMemo(
    () => ({ tabs, activeKey, setActiveKey, open, ensure, close, embed, setEmbed }),
    [tabs, activeKey, open, ensure, close, embed],
  );
}
