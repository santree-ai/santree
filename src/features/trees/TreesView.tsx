/** The Trees tab: worktree list · terminal/diff per worktree · broadcast view. */
import type { CSSProperties } from "react";

import { ViewChrome } from "../../components/chrome/ViewChrome";
import { useWorktreeDiff } from "../../lib/queries";
import { AgentTranscriptView } from "./AgentTranscriptView";
import { AllAgentsView } from "./AllAgentsView";
import { DiffView } from "./DiffView";
import { FileTreePanel } from "./FileTreePanel";
import { TreesProvider, useTrees } from "./model";
import { TreeTabs } from "./TreeTabs";
import { WorktreeSidebar } from "./WorktreeSidebar";

function viewTabStyle(active: boolean): CSSProperties {
  return active
    ? { background: "color-mix(in srgb, var(--accent) 9%, transparent)", color: "var(--accent)" }
    : { background: "transparent", color: "var(--color-muted-2)" };
}

/** Terminal/Diff toggle + status, shown only in single-worktree scope. */
function WorktreeToolbar() {
  const { activeId, treeView, setTreeView } = useTrees();
  const { data: diff } = useWorktreeDiff(activeId);
  const fileCount = diff?.files.length ?? 0;
  const clean = diff?.clean ?? true;

  return (
    <div className="flex h-10 flex-none items-center justify-between border-b border-line bg-deep px-3">
      <div className="flex gap-[3px] rounded-lg border border-line-2 bg-input p-[3px]">
        <button
          type="button"
          onClick={() => setTreeView("terminal")}
          className="cursor-pointer rounded-md border-none px-3 py-1 text-[11.5px]"
          style={viewTabStyle(treeView === "terminal")}
        >
          Terminal
        </button>
        <button
          type="button"
          onClick={() => setTreeView("diff")}
          className="cursor-pointer rounded-md border-none px-3 py-1 text-[11.5px]"
          style={viewTabStyle(treeView === "diff")}
        >
          {fileCount > 0 ? `Diff · ${fileCount}` : "Diff"}
        </button>
      </div>
      {!clean && fileCount > 0 ? (
        <div className="font-mono text-[11px] text-muted-3">uncommitted changes</div>
      ) : (
        diff?.prNote && (
          <div className="flex items-center gap-[7px] font-mono text-[11px] text-status-green">
            <span className="h-1.5 w-1.5 rounded-full bg-status-green" />
            {diff.prNote}
          </div>
        )
      )}
    </div>
  );
}

function TreesContent() {
  const { scopeAll, treeView } = useTrees();

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <TreeTabs />
      {!scopeAll && <WorktreeToolbar />}
      <div className="flex min-h-0 flex-1">
        {!scopeAll && <FileTreePanel />}
        <div className="flex min-w-0 flex-1 flex-col bg-app">
          {scopeAll ? (
            <AllAgentsView />
          ) : treeView === "terminal" ? (
            <AgentTranscriptView />
          ) : (
            <DiffView />
          )}
        </div>
      </div>
    </div>
  );
}

export function TreesView() {
  return (
    <TreesProvider>
      <ViewChrome sidebar={<WorktreeSidebar />}>
        <TreesContent />
      </ViewChrome>
    </TreesProvider>
  );
}
