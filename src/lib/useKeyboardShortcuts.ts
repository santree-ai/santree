/**
 * Global keyboard shortcuts, mounted once in the app shell.
 *
 * ⌘; / ⌘, → Settings · ⌘1…⌘N → the sidebar's destinations in `SidebarNav` order
 * (Triage when enabled, then Tickets and Reviews) · ⌘B → sidebar · ⌘⇧R → re-pull
 * Linear and GitHub · Esc → back to the view Settings was opened from. The
 * destination routes are guarded by the views themselves, so an unavailable
 * target (e.g. Triage while disabled) simply redirects back.
 *
 * Also home to {@link targetOwnsKey}, the guard the view-local shortcut
 * listeners share so they all treat text fields and terminals the same way.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAppOptional, useAppUiOptional } from "../state/AppContext";
import { useRefreshExternal } from "./queries";
import { applyZoom, DEFAULT_ZOOM, loadZoom, step } from "./zoom";

/** True when focus is in a field where keystrokes should be left alone. */
export function inEditable(target: EventTarget | null): boolean {
  // `target` is whatever the event carried — often `window`, and `isContentEditable`
  // is undefined on anything that isn't a real element. Compare explicitly so the
  // declared `boolean` is the truth.
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable === true;
}

/** True when focus is inside a terminal — xterm's hidden helper textarea, which
 *  reads as a plain TEXTAREA to {@link inEditable}. `.xterm` is the class xterm
 *  puts on the element it owns (and what its stylesheet targets). */
function inTerminal(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el?.closest?.(".xterm") != null;
}

/**
 * The guard every app shortcut starts with: true when the focused element owns
 * this keystroke and the app should stay out of the way.
 *
 * A text field owns every key. A terminal is narrower: it owns unmodified keys
 * and Ctrl-chords (^C, ^D, ^R are the shell's), but **not** ⌘/Super chords —
 * ⌘T, ⌘L, ⌘B, ⌘1… are app chrome and mean nothing to a shell, so they have to
 * keep working while an agent has focus.
 */
export function targetOwnsKey(e: KeyboardEvent): boolean {
  if (inTerminal(e.target)) return e.ctrlKey || !e.metaKey;
  return inEditable(e.target);
}

/**
 * Bind the digits 1..N to a menu's rows for as long as the caller is mounted —
 * mount it with the open menu, so the listener is live exactly while the menu is
 * on screen (the open-in menu, the new-tab menu). A `null` row is inert but still
 * *owns* its number: the key is swallowed rather than leaking to the app (a
 * disabled/WIP row must not fall through to a global shortcut).
 */
export function useDigitShortcuts(rows: readonly ((() => void) | null)[]) {
  // The caller rebuilds its rows every render; read them through a ref so the
  // window listener is bound once instead of re-subscribing on each keystroke.
  const latest = useRef(rows);
  latest.current = rows;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || targetOwnsKey(e)) return;
      const n = Number(e.key);
      const current = latest.current;
      if (!Number.isInteger(n) || n < 1 || n > current.length) return;
      e.preventDefault();
      current[n - 1]?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  // Optional: this runs in the route root, which can render for a tick before
  // the app provider during a hot reload — degrade gracefully, never crash.
  const app = useAppOptional();
  const ui = useAppUiOptional();
  const triageEnabled = app?.triageEnabled ?? false;
  const toggleSidebar = ui?.toggleSidebar;
  const toggleShortcuts = ui?.toggleShortcuts;
  const toggleCommandPalette = ui?.toggleCommandPalette;
  const { refresh } = useRefreshExternal();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Where Settings was opened from, so Esc goes back there instead of always
  // dumping you on Issues (Settings is reachable from every view).
  const lastView = useRef("/");
  useEffect(() => {
    if (pathname !== "/settings") lastView.current = pathname;
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc leaves Settings — but never steal it from an open field.
      if (e.key === "Escape" && pathname === "/settings" && !targetOwnsKey(e)) {
        e.preventDefault();
        navigate({ to: lastView.current });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      // Text size. Checked before the shift guard below, because ⌘+ *is* a shifted
      // chord on most layouts (⌘⇧=) — and handled even inside a focused terminal,
      // since scaling the app is chrome, not something a shell can mean.
      if (mod && !e.altKey) {
        const dir = e.key === "+" || e.key === "=" ? 1 : e.key === "-" || e.key === "_" ? -1 : 0;
        if (dir !== 0) {
          e.preventDefault();
          applyZoom(step(loadZoom(), dir as 1 | -1));
          return;
        }
        if (e.key === "0") {
          e.preventDefault();
          applyZoom(DEFAULT_ZOOM);
          return;
        }
        // ⌘⇧R — re-pull Linear + GitHub. Shifted on purpose (plain ⌘R is the
        // webview's own reload), which is also why it's handled up here, above
        // the guard below that drops every shifted chord. `e.key` is the shifted
        // character, so match the capital.
        if (e.shiftKey && e.key === "R") {
          e.preventDefault();
          refresh();
          return;
        }
      }

      // Shift is never part of a global binding — without this, ⌘⇧; (and any other
      // shifted combo whose base key matches) would fire the unshifted shortcut.
      if (!mod || e.altKey || e.shiftKey) return;

      if (e.key === ";" || e.key === ",") {
        e.preventDefault();
        navigate({ to: "/settings" });
        return;
      }

      if (e.key === "/" && toggleShortcuts) {
        e.preventDefault();
        toggleShortcuts();
        return;
      }

      if (e.key.toLowerCase() === "k" && toggleCommandPalette) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (e.key === "b" && toggleSidebar) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘1…⌘N map to the sidebar's destinations, top to bottom: Triage when
      // enabled, Tickets, then Reviews. Keep this in sync with `SidebarNav` so
      // the numbers match what's on screen. The workspace (`/trees`) is
      // deliberately unnumbered — it is reached by picking a worktree — and ⌘0 is
      // already the zoom reset.
      const paths = [...(triageEnabled ? ["/triage"] : []), "/issues", "/reviews"];
      const idx = Number(e.key) - 1;
      const to = Number.isInteger(idx) && idx >= 0 ? paths[idx] : undefined;
      if (to) {
        e.preventDefault();
        navigate({ to });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    navigate,
    pathname,
    triageEnabled,
    toggleSidebar,
    toggleShortcuts,
    toggleCommandPalette,
    refresh,
  ]);
}
