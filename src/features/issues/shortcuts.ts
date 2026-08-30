/**
 * The ticket-surface keyboard chords, in one place.
 *
 * Both hosts of the dependency graph bind the same two chords, but they own the
 * state behind them differently: the standalone view reads them off the model,
 * while the Tickets page owns the actionable filter itself (its header chip has
 * to show the same state in List mode, where no model is mounted). Sharing the
 * binding keeps the chords identical wherever the graph is embedded — the one
 * thing that must not drift between the two.
 */
import { useEffect } from "react";

import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";

/**
 * Bind ⌘⇧. ("Actionable only", the chord Finder uses for hidden files) and ⌘L
 * (the right inspector, mirroring ⌘B for the sidebar). A handler left out is not
 * bound at all, so a host without a right panel doesn't swallow ⌘L.
 */
export function useIssuesShortcuts({
  onToggleActionable,
  onToggleRightPanel,
}: {
  onToggleActionable?: () => void;
  onToggleRightPanel?: () => void;
}): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (targetOwnsKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      // Use e.code so the Shift modifier (which would turn "." into ">") doesn't matter.
      if (e.shiftKey && e.code === "Period" && onToggleActionable) {
        e.preventDefault();
        onToggleActionable();
      } else if (!e.shiftKey && e.code === "KeyL" && onToggleRightPanel) {
        e.preventDefault();
        onToggleRightPanel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggleActionable, onToggleRightPanel]);
}
