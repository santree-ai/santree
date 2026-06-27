/**
 * Embed a live terminal session over an arbitrary host element.
 *
 * Both the triage Investigate pane and the Settings login terminal need the
 * same subtle lifecycle, so it lives here once:
 *
 *  1. `ensure(...)` an (idempotent) session for the spec's `refId`, then point
 *     the persistent {@link TerminalLayer} at our host via `setEmbed`. The host
 *     rect is captured *synchronously* inside a `useLayoutEffect` and handed to
 *     `setEmbed`, so the layer is correctly sized on the very first paint — the
 *     ResizeObserver only re-measures afterward. Without this the PTY opens at
 *     the full content-area size for a frame and reflows (documented sizing
 *     race). The layout effect (not a passive effect) also tears the embed down
 *     synchronously with the DOM commit, so the overlay never lingers over other
 *     content behind a deferred re-render.
 *
 *  2. A "seen latch": when the hosted process exits, the orchestrator removes
 *     its tab. We can't fire `onExited` the moment the tab is missing, because
 *     on the very first render the tab hasn't registered yet. So we wait until
 *     we've *seen* our key present in `tabs` (latch true), and only then treat
 *     its disappearance as a real exit.
 *
 * The caller owns what happens on exit (close the ephemeral investigate tab,
 * close the login panel, …) and may force an early teardown via `close()`.
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

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
  /** When false, no session is embedded (host stays empty). Defaults to true. */
  enabled?: boolean;
}): UseEmbeddedTerminalResult {
  const { spec, onExited, enabled = true } = opts;
  const { tabs, ensure, close: closeTab, setEmbed } = useTerminals();

  const hostRef = useRef<HTMLDivElement | null>(null);
  const keyRef = useRef<string | null>(null);
  const seenRef = useRef(false);

  // Latest exit callback without forcing the embed effect to re-run.
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // Pull the spec into primitive fields so the embed effect re-runs on real
  // changes (a new ticket/command) rather than on every render's fresh object
  // identity. args/env are folded into stable string keys.
  const { title, cwd, command, args, env, seed, source, refId } = spec;
  const argsKey = args?.join(" ");
  const envKey = env && JSON.stringify(env);

  // biome-ignore lint/correctness/useExhaustiveDependencies: argsKey/envKey stand in for args/env.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !enabled) return;
    const key = ensure({ title, cwd, command, args, env, seed, source, refId });
    keyRef.current = key;
    seenRef.current = false;
    // Capture the host's current rect synchronously so the layer is sized right
    // on first paint (opens at the correct size, not the full content area).
    const r = host.getBoundingClientRect();
    setEmbed({ host, key, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
    return () => setEmbed(null);
  }, [enabled, title, cwd, command, seed, source, refId, argsKey, envKey, ensure, setEmbed]);

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
    if (key) closeTab(key);
    setEmbed(null);
  }, [closeTab, setEmbed]);

  return { hostRef, close };
}
