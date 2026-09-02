/**
 * The Triage workspace's keyboard model. Small on purpose: the queue lives in
 * the sidebar and its selection in the route, so all that is left to a hook here
 * is the vim-style stepping between tickets and the two ⌘ actions on the open one.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

import type { TriageDetail, TriageTicket } from "../../bindings";
import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";

/**
 * Vim-style queue navigation, mounted on `window`: j / k step through the queue,
 * ⌘I investigates the current issue, ⌘O opens it in Linear, ⌘L shows or hides
 * the ticket panel (the same key Trees and Reviews give their rails). Skipped
 * while focus is in a field (incl. the embedded terminal, whose xterm input is
 * a textarea), so these keys never steal from the agent.
 */
export function useTriageKeyboard(opts: {
  /** Every ticket the sidebar lists, in its order — active, then snoozed. */
  ordered: TriageTicket[];
  activeId: string | null;
  detail: TriageDetail | undefined;
  onSelect: (id: string) => void;
  onInvestigate: () => void;
  /** Toggle the right rail. Only with a ticket open: without a workspace there
   *  is no rail, and flipping a persisted flag nobody can see is a surprise
   *  saved for later. */
  onTogglePanel: () => void;
}) {
  const { ordered, activeId, detail, onSelect, onInvestigate, onTogglePanel } = opts;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (targetOwnsKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.altKey && (e.key === "i" || e.key === "I")) {
        if (!activeId) return;
        e.preventDefault();
        onInvestigate();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyL") {
        if (!activeId) return;
        e.preventDefault();
        onTogglePanel();
        return;
      }
      if (mod && !e.altKey && (e.key === "o" || e.key === "O")) {
        // Open the current issue in Linear (same as the "Open Issue" button);
        // the URL only exists once the detail has loaded.
        if (!detail) return;
        e.preventDefault();
        openUrl(detail.url);
        return;
      }
      if (mod || e.altKey) return;

      if (e.key === "j" || e.key === "k") {
        if (ordered.length === 0) return;
        e.preventDefault();
        const idx = ordered.findIndex((t) => t.id === activeId);
        const delta = e.key === "j" ? 1 : -1;
        // Clamp at the ends; with no selection, j picks the first / k the last.
        const nextIdx =
          idx === -1
            ? delta === 1
              ? 0
              : ordered.length - 1
            : Math.min(Math.max(idx + delta, 0), ordered.length - 1);
        const next = ordered[nextIdx];
        if (!next || next.id === activeId) return;
        onSelect(next.id);
        // Keep the newly-selected row visible in the sidebar's scrolling section.
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-ticket-id="${CSS.escape(next.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, activeId, detail, onSelect, onInvestigate, onTogglePanel]);
}
