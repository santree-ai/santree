/**
 * Global keyboard shortcuts, mounted once in the app shell.
 *
 * ⌘; / ⌘, → Settings · ⌘1…⌘N → tabs in NavTabs order (Triage when enabled,
 * then Issues/Trees/Reviews/Terminal) · ⌘B → sidebar · Esc → leave Settings.
 * Tab navigation routes are guarded by the views themselves, so an unavailable
 * target (e.g. Triage while disabled) simply redirects back.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAppOptional } from "../state/AppContext";

/** True when focus is in a field where keystrokes should be left alone. */
export function inEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  // Optional: this runs in the route root, which can render for a tick before
  // the app provider during a hot reload — degrade gracefully, never crash.
  const app = useAppOptional();
  const triageEnabled = app?.triageEnabled ?? false;
  const toggleSidebar = app?.toggleSidebar;
  const toggleShortcuts = app?.toggleShortcuts;
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Esc leaves Settings — but never steal it from an open field.
      if (e.key === "Escape" && pathname === "/settings" && !inEditable(e.target)) {
        e.preventDefault();
        navigate({ to: "/" });
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;

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

      if (e.key === "b" && toggleSidebar) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⌘1…⌘N map to the tabs in the same left-to-right order NavTabs renders
      // them: Triage leads when enabled, then Issues, Trees, Reviews, Terminal.
      // Keep this in sync with NavTabs so the numbers match what's on screen.
      const paths = [
        ...(triageEnabled ? ["/triage"] : []),
        "/", // Issues
        "/trees",
        "/reviews",
        "/terminal",
      ];
      const idx = Number(e.key) - 1;
      const to = Number.isInteger(idx) && idx >= 0 ? paths[idx] : undefined;
      if (to) {
        e.preventDefault();
        navigate({ to });
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, pathname, triageEnabled, toggleSidebar, toggleShortcuts]);
}
