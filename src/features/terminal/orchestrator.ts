/**
 * The app's terminal orchestration API — strictly placement + seeding, nothing
 * more (see COMPLIANCE.md). It tracks open sessions as tabs and can open a new
 * one for a given cwd/command, optionally with a single human-initiated seed
 * prompt. It does NOT parse output, drive the CLI, or touch credentials.
 */
import { useCallback, useMemo, useRef, useState } from "react";

/** Where a terminal was opened from. Pairs with `refId` to identify a session:
 *  the Agents panel maps a stored `term_key` back to its live PTY through it. */
export type TerminalSource = "shell" | "triage" | "issue" | "review";

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

/** One claim on the inline slot, tagged with an identity so releasing it can't
 *  drop somebody else's claim. */
interface EmbedClaim {
  id: number;
  embed: TerminalEmbed;
}

let embedSeq = 0;

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
  /** The session currently embedded inline (e.g. the triage Investigate tab) —
   *  the newest live claim. */
  embed: TerminalEmbed | null;
  /** Claim the inline slot. Returns a release fn that hands the slot back to
   *  whoever held it before, rather than blanking it: claims overlap (a route
   *  swap mounts the incoming host before the outgoing one's cleanup runs), and
   *  a release that cleared the slot outright left the still-mounted host with a
   *  layer pointed nowhere and no reason to re-register. */
  attachEmbed: (embed: TerminalEmbed) => () => void;
  /** Drop every claim on a session — its process died, so nothing should stay
   *  pointed at it. */
  detachEmbeds: (key: string) => void;
  /** Register a live session's input channel, so it can be typed into from
   *  outside its pane. Called by the render layer once the PTY is open; returns
   *  an unregister fn. */
  registerInput: (key: string, write: (data: string) => void) => () => void;
  /** Type `data` into a live session as if the user typed it there — used by the
   *  Agents panel's reply box. Returns false when the session has no live PTY.
   *
   *  Placement + human-initiated input only (see COMPLIANCE.md): the text is
   *  whatever the user wrote, nothing here reads the agent's output or decides
   *  what to send. */
  send: (key: string, data: string) => boolean;
}

export function useTerminalTabs(initial: TerminalSpec[] = []): TerminalTabs {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => initial.map(withKey));
  const [activeKey, setActiveKey] = useState<string | null>(tabs[0]?.key ?? null);
  const [claims, setClaims] = useState<EmbedClaim[]>([]);
  const embed = claims.length > 0 ? claims[claims.length - 1].embed : null;
  // Mirror the latest tabs so the mutators below can decide (and derive the next
  // activeKey) without an impure — StrictMode double-invoked — state updater.
  // Every writer updates the ref eagerly, so two calls in one tick see each other.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const open = useCallback((spec: TerminalSpec) => {
    const tab = withKey(spec);
    tabsRef.current = [...tabsRef.current, tab];
    setTabs(tabsRef.current);
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
    setTabs(tabsRef.current);
    return tab.key;
  }, []);

  // Closing the active tab falls back to the tab before it.
  const close = useCallback((key: string) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.key === key);
    if (idx === -1) return;
    const next = prev.filter((t) => t.key !== key);
    tabsRef.current = next;
    setTabs(next);
    setActiveKey((cur) => (cur === key ? (next[Math.max(0, idx - 1)]?.key ?? null) : cur));
  }, []);

  // Input channels of the live panes, keyed by tab. A ref, not state: this is a
  // side-channel for imperative writes and re-rendering on registration would
  // churn every consumer of the context for no visual change.
  const inputs = useRef(new Map<string, (data: string) => void>());

  const registerInput = useCallback((key: string, write: (data: string) => void) => {
    inputs.current.set(key, write);
    return () => {
      // Only drop our own registration — a remounting pane can register the next
      // writer before the previous one's cleanup runs.
      if (inputs.current.get(key) === write) inputs.current.delete(key);
    };
  }, []);

  const send = useCallback((key: string, data: string) => {
    const write = inputs.current.get(key);
    if (!write) return false;
    write(data);
    return true;
  }, []);

  const attachEmbed = useCallback((next: TerminalEmbed) => {
    const id = embedSeq++;
    setClaims((prev) => [...prev, { id, embed: next }]);
    return () => setClaims((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const detachEmbeds = useCallback((key: string) => {
    setClaims((prev) =>
      prev.some((c) => c.embed.key === key) ? prev.filter((c) => c.embed.key !== key) : prev,
    );
  }, []);

  return useMemo(
    () => ({
      tabs,
      activeKey,
      setActiveKey,
      open,
      ensure,
      close,
      embed,
      attachEmbed,
      detachEmbeds,
      registerInput,
      send,
    }),
    [tabs, activeKey, open, ensure, close, embed, attachEmbed, detachEmbeds, registerInput, send],
  );
}
