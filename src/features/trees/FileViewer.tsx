/** The File tab's content: the file picked in the right-hand explorer/changes
 *  list. Changed files render as a diff; any other file shows its current
 *  contents. A slim header names the file (the tab bar owns navigation). */
import { EmptyState, TerminalActivity } from "../../components/primitives";
import { useWorktreeFileSource, useWorktreeStatus } from "../../lib/queries";
import { CodeView } from "./CodeView";
import { DiffPane } from "./DiffPane";
import { useTrees } from "./model";

export function FileViewer() {
  const { repo, activeId, selectedFile } = useTrees();
  const { data: status = [] } = useWorktreeStatus(repo, activeId);
  if (!selectedFile) return null;

  const changed = status.some((f) => f.path === selectedFile);

  return (
    <div className="flex h-full min-w-0 flex-col bg-app">
      <div className="flex h-8 flex-none items-center border-b border-line bg-deep px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-2">
          {selectedFile}
        </span>
      </div>
      {changed ? <DiffPane /> : <PlainFileView />}
    </div>
  );
}

/** An unchanged file's current contents (from the working tree). */
function PlainFileView() {
  const { repo, activeId, selectedFile } = useTrees();
  const { data: source, isLoading } = useWorktreeFileSource(repo, activeId, selectedFile ?? "");

  if (isLoading || source === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <TerminalActivity label="Loading file…" />
      </div>
    );
  }
  const text = source.newText;
  // A NUL byte means the backend decoded a binary file as lossy UTF-8 — don't dump it.
  if (text.includes("\u0000")) {
    return <EmptyState title="Binary file" subtitle="There's nothing to display for this file." />;
  }
  if (text === "") {
    return <EmptyState title="Empty file" />;
  }

  return <CodeView path={selectedFile ?? ""} content={text} />;
}
