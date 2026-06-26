/** Right column of the Issues tab: Inspector / Sessions tabbed panel. */
import type { CSSProperties } from "react";

import { InspectorPanel } from "./InspectorPanel";
import { useIssues } from "./model";
import { SessionsPanel } from "./SessionsPanel";

function tabStyle(active: boolean): CSSProperties {
  return active
    ? { color: "var(--color-fg-bright)", boxShadow: "inset 0 -2px 0 var(--accent)" }
    : { color: "var(--color-muted-3)" };
}

export function RightPanel() {
  const { rightTab, setRightTab, sessions } = useIssues();
  const inspector = rightTab === "inspector";

  return (
    <div className="flex w-[304px] flex-none flex-col border-l border-line bg-panel">
      <div className="flex h-10 flex-none border-b border-hairline">
        <button
          type="button"
          onClick={() => setRightTab("inspector")}
          className="flex-1 cursor-pointer border-none bg-transparent text-[12.5px] font-medium"
          style={tabStyle(inspector)}
        >
          Inspector
        </button>
        <button
          type="button"
          onClick={() => setRightTab("sessions")}
          className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 border-none bg-transparent text-[12.5px] font-medium"
          style={tabStyle(!inspector)}
        >
          Sessions
          {sessions.length > 0 && (
            <span
              className="rounded-[7px] px-[5px] font-mono text-[10px] text-[#06231a]"
              style={{ background: "var(--accent)" }}
            >
              {sessions.length}
            </span>
          )}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {inspector ? <InspectorPanel /> : <SessionsPanel />}
      </div>
    </div>
  );
}
