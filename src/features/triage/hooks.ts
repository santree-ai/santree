/**
 * Triage view logic, pulled out of the (otherwise JSX-light) orchestrator so
 * each concern is small, named, and testable on its own:
 *
 *  - `useTriageSelection`  — the active-ticket selection, kept valid as the queue
 *    changes underneath it.
 *  - `useTabByTicket`      — per-ticket detail-tab memory (each ticket remembers
 *    Discussion vs Investigation independently).
 *  - `useKeptPanes`        — the mounted-pane cache (keep recently-viewed panes
 *    mounted, toggle visibility) so revisiting a ticket is instant.
 *  - `useTriageKeyboard`   — the vim-style queue keybindings (j/k, ⌘I, ⌘O).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { TriageDetail, TriageTicket } from "../../bindings";
import { inEditable } from "../../lib/useKeyboardShortcuts";

/** Which detail tab a ticket is showing. */
export type DetailTab = "discussion" | "investigate";

/**
 * The selected ticket. `selectedId` is the raw click target; `activeId` is the
 * resolved selection — falling back to the head of the queue when nothing is
 * selected (or the selection has dropped out of `visible`, e.g. after a triage),
 * so a stale id never strands the pane on a blank.
 */
export function useTriageSelection(ordered: TriageTicket[], visible: TriageTicket[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeId =
    selectedId && visible.some((t) => t.id === selectedId) ? selectedId : (ordered[0]?.id ?? null);
  const activeTicket = visible.find((t) => t.id === activeId) ?? null;

  const select = useCallback((id: string) => setSelectedId(id), []);

  return { activeId, activeTicket, select };
}

/**
 * Per-ticket detail-tab memory: each ticket remembers whichever tab it was on
 * (Discussion or Investigation) so switching tickets and coming back restores
 * it. `tabFor(id)` defaults to Discussion until the ticket's investigation opens.
 */
export function useTabByTicket() {
  const [tabByTicket, setTabByTicket] = useState<Record<string, DetailTab>>({});

  const tabFor = useCallback(
    (id: string | null): DetailTab => (id ? (tabByTicket[id] ?? "discussion") : "discussion"),
    [tabByTicket],
  );
  const setTab = useCallback((id: string | null, tab: DetailTab) => {
    if (id) setTabByTicket((m) => ({ ...m, [id]: tab }));
  }, []);

  return { tabFor, setTab };
}

/**
 * A mounted-pane cache for expensive detail bodies (markdown + inline base64
 * images): keep the most-recently-viewed panes mounted and just toggle their
 * visibility, so revisiting a ticket is instant (no re-parse).
 *
 * A pane is added at *transition* priority, so its first heavy render never
 * blocks the click — the row highlight + header commit immediately, and the
 * body's paint lands in the deferred commit. `detailFor(id)` snapshots each
 * ticket's detail so inactive (hidden) panes keep rendering their own content
 * even after the active detail has moved on.
 *
 * Generic over the detail shape; callers feed the currently-active detail.
 */
export function useKeptPanes<D extends { id: string }>(activeDetail: D | undefined, max: number) {
  const detailsRef = useRef(new Map<string, D>());
  const [keptPanes, setKeptPanes] = useState<string[]>([]);

  useEffect(() => {
    if (!activeDetail) return;
    detailsRef.current.set(activeDetail.id, activeDetail);
    startTransition(() => {
      setKeptPanes((cur) =>
        cur.includes(activeDetail.id) ? cur : [...cur, activeDetail.id].slice(-max),
      );
    });
  }, [activeDetail, max]);

  const detailFor = useCallback((id: string) => detailsRef.current.get(id), []);

  return { keptPanes, detailFor };
}

/**
 * Vim-style queue navigation, mounted on `window`: j / k step through the queue,
 * ⌘I investigates the current issue, ⌘O opens it in Linear. Skipped while focus
 * is in a field (incl. the embedded terminal, whose xterm input is a textarea),
 * so these keys never steal from the agent.
 */
export function useTriageKeyboard(opts: {
  ordered: TriageTicket[];
  activeId: string | null;
  detail: TriageDetail | undefined;
  onSelect: (id: string) => void;
  onInvestigate: () => void;
}) {
  const { ordered, activeId, detail, onSelect, onInvestigate } = opts;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (inEditable(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && !e.altKey && (e.key === "i" || e.key === "I")) {
        if (!activeId) return;
        e.preventDefault();
        onInvestigate();
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
        // Keep the newly-selected row visible in the scrollable queue.
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-ticket-id="${CSS.escape(next.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, activeId, detail, onSelect, onInvestigate]);
}
