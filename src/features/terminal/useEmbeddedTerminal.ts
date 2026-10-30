/**
 * Embed a live terminal session over an arbitrary host element.
 *
 * Both the triage Investigate pane and the Settings login terminal need the
 * same subtle lifecycle, so it lives here once:
 *
 *  1. `ensure(...)` an (idempotent) session for the spec's `refId`, then point
 *     the persistent {@link TerminalLayer} at our host via `attachEmbed`. A
 *     layout effect, not a passive one, on both edges: the claim is flushed
 *     inside the same commit, so the layer measures and places itself over this
 *     host before the first paint (no frame at the wrong size), and the release
 *     is synchronous with the DOM commit, so the overlay never lingers over other
 *     content behind a deferred re-render.
 *
 *  2. A "seen latch": when the hosted process exits, the orchestrator removes
 *     its tab. We can't fire `onExited` the moment the tab is missing, because
 *     on the very first render the tab hasn't registered yet. So we wait until
 *     we've *seen* our key present in `tabs` (latch true), and only then treat
 *     its disappearance as a real exit. The latch is the session's: showing or
 *     hiding the pane (`attach`) keeps it, so a host can flip that without
 *     remounting.
 *
 * The caller owns what happens on exit (close the ephemeral investigate tab,
 * close the login panel, …) and may force an early teardown via `close()`.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { useSplitPane } from "../../components/split/SplitPaneContext";
import type { TerminalSpec } from "./orchestrator";
import { useTerminals } from "./TerminalsContext";

/** The session to embed: a normal {@link TerminalSpec} with a required `refId`. */
export type EmbeddedTerminalSpec = TerminalSpec & { refId: string };

export interface UseEmbeddedTerminalResult {
  /** Attach to the element the session should overlay. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Force-close the session now (e.g. a manual ✕ button). */
  close: () => void;
}

export function useEmbeddedTerminal(opts: {
  /**
   * The `ensure(...)` argument: title / cwd / command / seed / source / refId.
   * The embed re-runs when any meaningful field changes, so callers may build a
   * fresh object each render.
   */
  spec: EmbeddedTerminalSpec;
  /** Fired once when the hosted process exits (its tab is removed). */
  onExited?: () => void;
  /**
   * Whether to display the session over `hostRef` (default) or merely keep it
   * running. The off-screen background launcher wants the session — a real PTY,
   * seeded, sized by the layer like any other pane — but must NOT show it: the
   * inline slot belongs to whatever terminal the user is actually looking at.
   */
  attach?: boolean;
  /** The surface's own Resume, handed to a lost pane (see `TerminalEmbed.onResume`). */
  onResume?: () => void;
}): UseEmbeddedTerminalResult {
  const { spec, onExited, attach = true, onResume } = opts;
  const { tabs, ensure, close: closeTab, attachEmbed, detachEmbeds } = useTerminals();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<string | null>(null);
  const seenRef = useRef(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Latest exit callback without forcing the embed effect to re-run.
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  // A press inside the session focuses the split group it is shown in — the
  // layer draws the terminal, so the group never sees that press itself.
  const pane = useSplitPane();
  const activateRef = useRef(pane?.activate);
  activateRef.current = pane?.activate;
  // Whether the user is working where this host is: the keyboard goes only to a
  // claim made there (`TerminalTabs.embed`).
  const focused = pane?.focused ?? true;
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;
  const resumable = onResume !== undefined;

  // Pull the spec into primitive fields so the embed effect re-runs on real
  // changes (a new ticket/command) rather than on every render's fresh object
  // identity. args is folded into a stable string key.
  const { title, cwd, command, args, seed, source, refId, agent } = spec;
  const argsKey = args?.join(" ");
  // Same treatment as `args`: the identity is a fresh object every render, and
  // only a real change of provider/repo/surface should re-run the embed.
  const agentKey = agent && `${agent.kind} ${agent.repo} ${agent.termKey}`;

  // The session. The latch starts over only for another session: were it
  // lowered on a re-run for the same one, nothing would raise it again —
  // `tabs` hasn't changed — and the next exit would go unseen. A session
  // already in the registry has been seen; one `ensure` just opened is, once it
  // lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: argsKey/agentKey stand in for args/agent.
  useLayoutEffect(() => {
    const key = ensure({ title, cwd, command, args, seed, source, refId, agent });
    if (key === keyRef.current) return;
    keyRef.current = key;
    seenRef.current = tabsRef.current.some((t) => t.key === key);
  }, [title, cwd, command, seed, source, refId, argsKey, agentKey, ensure]);

  // The slot, claimed while the pane is shown. Showing or hiding the pane
  // (`attach`), or its group gaining or losing focus, claims again — and only
  // that: an `ensure` there would reopen a session that has since exited. It
  // re-runs with the session effect above, which it follows, for the key that
  // one settled.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the spec fields re-key the claim to the session the effect above settled.
  useLayoutEffect(() => {
    const key = keyRef.current;
    const host = hostRef.current;
    if (!attach || !host || !key) return;
    return attachEmbed({
      host,
      key,
      focused,
      onActivate: () => activateRef.current?.(),
      onResume: resumable ? () => onResumeRef.current?.() : undefined,
    });
  }, [
    title,
    cwd,
    command,
    seed,
    source,
    refId,
    argsKey,
    agentKey,
    attach,
    focused,
    resumable,
    attachEmbed,
  ]);

  // Seen-latch exit detection (see the file header).
  useEffect(() => {
    const key = keyRef.current;
    if (!key) return;
    if (tabs.some((t) => t.key === key)) {
      seenRef.current = true;
    } else if (seenRef.current) {
      keyRef.current = null;
      seenRef.current = false;
      onExitedRef.current?.();
    }
  }, [tabs]);

  const close = useCallback(() => {
    const key = keyRef.current;
    if (!key) return;
    closeTab(key);
    detachEmbeds(key);
  }, [closeTab, detachEmbeds]);

  return { hostRef, close };
}
