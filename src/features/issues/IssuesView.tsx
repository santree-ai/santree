/** The Issues tab: ticket list · dependency graph · inspector/sessions. */
import { useEffect } from "react";

import { ViewChrome } from "../../components/chrome/ViewChrome";
import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";
import { GraphCanvas } from "./GraphCanvas";
import { IssueSidebar } from "./IssueSidebar";
import { IssuesProvider, useIssues } from "./model";
import { RightPanel } from "./RightPanel";

/**
 * Issues-tab-local shortcuts (only while this view is mounted):
 * ⌘L toggles the right panel (mirrors ⌘B for the sidebar) and ⌘⇧. toggles the
 * "Actionable only" graph filter — the same chord Finder uses for hidden files.
 */
function IssuesShortcuts() {
  const { toggleRightPanel, toggleActionableOnly } = useIssues();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (targetOwnsKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      // Use e.code so the Shift modifier (which would turn "." into ">") doesn't matter.
      if (e.shiftKey && e.code === "Period") {
        e.preventDefault();
        toggleActionableOnly();
      } else if (!e.shiftKey && e.code === "KeyL") {
        e.preventDefault();
        toggleRightPanel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRightPanel, toggleActionableOnly]);
  return null;
}

export function IssuesView() {
  return (
    <IssuesProvider>
      <IssuesShortcuts />
      <ViewChrome sidebar={<IssueSidebar />}>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-app">
          <GraphCanvas />
        </div>
        <RightPanel />
      </ViewChrome>
    </IssuesProvider>
  );
}
