/**
 * The app's terminal orchestration API — strictly placement + seeding, nothing
 * more (see COMPLIANCE.md). It tracks open sessions as tabs and can open a new
 * one for a given cwd/command, optionally with a single human-initiated seed
 * prompt. It does NOT parse output, drive the CLI, or touch credentials.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import type { AgentKind } from "../../bindings";

/** Where a terminal was opened from — a grouping, not an identity. A pane is
 *  identified by its `refId` (the surface's `term_key`) and the provider in it;
 *  see {@link TerminalSpec.refId}. */
export type TerminalSource = "shell" | "triage" | "issue" | "review";

/**
 * What santree knows about an agent it launched *before the agent says anything*.
 *
 * This is the app's own record of a launch, not a report from the CLI: santree
 * chose the surface, the repo and the provider, so all three are known the
 * instant the PTY is spawned. It exists because a provider's own announcement is
 * not guaranteed to be prompt — Codex creates its thread on the first submitted
 * turn and only fires `SessionStart` there, so a tab opened and left at the
 * prompt reports nothing at all (see `agentProvider.ts`). Without this the agent
 * registry, and therefore the sidebar, had nothing to show for it.
 *
 * All three fields together or none: a tab carrying a partial identity could be
 * filed under the wrong worktree, which is worse than not being filed at all.
 */
export interface AgentTabIdentity {
  kind: AgentKind;
  repo: string;
  /** The logical terminal's `term_key` — the same string the launch exports as
   *  `SANTREE_TERM_KEY` and the hook writes into `terminal_sessions`. */
  termKey: string;
}

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
  /** The surface this pane hosts, as its `term_key` — `tree:<id>`,
   *  `triage:<ticket>`, `ai-review:<owner>/<name>#<n>`, … — and nothing else.
   *
   *  It IS the label the PTY is opened under and the key the durable session row
   *  carries, so it must never be decorated: a provider-suffixed one stopped
   *  matching the row and the agent behind it read as exited. The provider is
   *  the other half of the pane's identity and travels in {@link agent}, which
   *  is why one surface can have a pane per provider. */
  refId?: string;
  /** Set when this tab hosts an agent santree launched; absent for a plain shell.
   *  See {@link AgentTabIdentity}. */
  agent?: AgentTabIdentity;
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

/** A session displayed inline somewhere other than the Terminal tab.
 *
 *  Just the host element: the layer measures it itself, in a layout effect that
 *  runs in the same commit as the claim and before the first paint, so there is
 *  no window in which a pre-captured rect would be the better answer. */
export interface TerminalEmbed {
  host: HTMLElement;
  key: string;
}

/** A live pane's imperative surface, registered by the render layer.
 *
 *  `write` is how a session is typed into from outside its own pane (the Agents
 *  panel's reply box); `end` is how its process is stopped. Both are held here
 *  rather than in the view so a caller that only has a tab key — a closing tab
 *  bar, a worktree being deleted — can reach the session behind it. */
export interface PaneHandle {
  write: (data: string) => void;
  end: () => void;
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
  /** Open a session for this pane if one doesn't exist yet; returns its key.
   *  Idempotent per `(source, refId, agent.kind)` — the pane's whole identity. */
  ensure: (spec: TerminalSpec & { refId: string }) => string;
  /** Close a tab and end its session.
   *
   *  This is the only thing that kills a process. A pane unmounting merely
   *  detaches — see `TerminalView` — so closing has to be said explicitly here,
   *  and it happens before the tab goes away while the handle still exists. */
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
  /** Register a live pane's imperative handle. Called by the render layer once
   *  the PTY is open; returns an unregister fn. */
  registerPane: (key: string, handle: PaneHandle) => () => void;
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

  // Reuse an existing session for the same (source, refId, provider) so
  // re-entering an issue's Investigate tab attaches to its live shell instead of
  // spawning a new one. Returns the existing or newly-created key.
  //
  // The provider is part of the key, not decoration on `refId`: a surface hosts
  // one session per provider (the pair `terminal_sessions` is keyed by), so a
  // Codex and a Claude investigation of one ticket are two panes — while two
  // calls naming the same provider are always the same pane.
  const ensure = useCallback((spec: TerminalSpec & { refId: string }) => {
    const source = spec.source ?? "shell";
    // An agent pane's surface key is the `term_key` it launched with, taken from
    // the identity itself rather than from a second argument that could disagree
    // with it. That is the whole of what went wrong before: a launch site keyed
    // its PTY by a decorated ref (`AK-1::codex`), the durable row was still keyed
    // by `triage:AK-1`, and the liveness join matched nothing — so a working
    // agent read as exited. Deriving it here makes that unrepresentable at the
    // one call every agent pane goes through.
    const refId = spec.agent?.termKey ?? spec.refId;
    const found = tabsRef.current.find(
      (t) => t.source === source && t.refId === refId && t.agent?.kind === spec.agent?.kind,
    );
    if (found) return found.key;
    const tab = withKey({ ...spec, refId });
    tabsRef.current = [...tabsRef.current, tab];
    setTabs(tabsRef.current);
    return tab.key;
  }, []);

  // Closing the active tab falls back to the tab before it.
  const close = useCallback((key: string) => {
    const prev = tabsRef.current;
    const idx = prev.findIndex((t) => t.key === key);
    if (idx === -1) return;
    // End the process before dropping the tab: removing it unmounts the pane,
    // and an unmounting pane only detaches. Ordered this way the handle is
    // still registered; the other way round nothing would be left to call.
    panes.current.get(key)?.end();
    const next = prev.filter((t) => t.key !== key);
    tabsRef.current = next;
    setTabs(next);
    setActiveKey((cur) => (cur === key ? (next[Math.max(0, idx - 1)]?.key ?? null) : cur));
  }, []);

  // Handles of the live panes, keyed by tab. A ref, not state: this is a
  // side-channel for imperative calls and re-rendering on registration would
  // churn every consumer of the context for no visual change.
  const panes = useRef(new Map<string, PaneHandle>());

  const registerPane = useCallback((key: string, handle: PaneHandle) => {
    panes.current.set(key, handle);
    return () => {
      // Only drop our own registration — a remounting pane can register the next
      // handle before the previous one's cleanup runs.
      if (panes.current.get(key) === handle) panes.current.delete(key);
    };
  }, []);

  const send = useCallback((key: string, data: string) => {
    const pane = panes.current.get(key);
    if (!pane) return false;
    pane.write(data);
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
      registerPane,
      send,
    }),
    [tabs, activeKey, open, ensure, close, embed, attachEmbed, detachEmbeds, registerPane, send],
  );
}
