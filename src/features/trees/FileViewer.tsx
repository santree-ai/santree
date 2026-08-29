/** The File tab's content: the file picked in the right-hand explorer/changes
 *  list. Changed files render as a diff; any other file shows its current
 *  contents. A slim header names the file (the tab bar owns navigation) and, for
 *  a markdown file, carries the Code/Preview toggle. */
import { type ReactElement, useState } from "react";

import { CodeIcon, MarkdownIcon } from "../../components/icons";
import { MarkdownDocument } from "../../components/Markdown";
import { EmptyState, Segmented, TerminalActivity } from "../../components/primitives";
import { useWorktreeFileSource, useWorktreeStatus } from "../../lib/queries";
import { CodeView } from "./CodeView";
import { DiffPane } from "./DiffPane";
import { useTrees } from "./model";

type ViewMode = "code" | "preview";

/** Whether a path is markdown, by extension. `.mdx` is deliberately out: it is
 *  JSX in markdown clothing, and rendering only the markdown half of it would
 *  quietly drop the components that carry the content. */
export function isMarkdownPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return path.includes(".") && (ext === "md" || ext === "markdown");
}

export function FileViewer() {
  const { repo, activeId, selectedFile, selectedFileScope } = useTrees();
  const { data: status = [] } = useWorktreeStatus(repo, activeId);
  // `null` = the user hasn't picked, so the default below applies. Once they
  // have, the choice sticks as they move between files — someone who switched to
  // the source meant it for more than one file.
  const [chosen, setChosen] = useState<ViewMode | null>(null);
  if (!selectedFile) return null;

  const changed = selectedFileScope === "branch" || status.some((f) => f.path === selectedFile);
  const markdown = isMarkdownPath(selectedFile);
  // A changed file was almost certainly clicked to see what changed, so the diff
  // leads there; an unchanged document was clicked to be read. Either way the
  // toggle is one click, and only the untouched default differs.
  const mode: ViewMode = markdown ? (chosen ?? (changed ? "code" : "preview")) : "code";

  return (
    <div className="flex h-full min-w-0 flex-col bg-app">
      <div className="flex h-8 flex-none items-center gap-3 border-b border-line bg-deep px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-2">
          {selectedFile}
        </span>
        {markdown && (
          <Segmented<ViewMode>
            className="h-[22px] w-[156px] flex-none"
            value={mode}
            onChange={setChosen}
            options={[
              { value: "code", label: changed ? "Diff" : "Code", icon: <CodeIcon size={11} /> },
              { value: "preview", label: "Preview", icon: <MarkdownIcon size={11} /> },
            ]}
          />
        )}
      </div>
      {mode === "preview" ? <MarkdownPreview /> : changed ? <DiffPane /> : <PlainFileView />}
    </div>
  );
}

/** The selected file's working-tree text, or the state that stands in for it.
 *  Shared by the source and preview panes so a binary or empty file says the
 *  same thing either way. */
function useFileText(): { text: string } | { fallback: ReactElement } {
  const { repo, activeId, selectedFile } = useTrees();
  const { data: source, isLoading } = useWorktreeFileSource(repo, activeId, selectedFile ?? "");

  if (isLoading || source === undefined) {
    return {
      fallback: (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <TerminalActivity label="Loading file…" />
        </div>
      ),
    };
  }
  const text = source.newText;
  // A NUL byte means the backend decoded a binary file as lossy UTF-8 — don't dump it.
  if (text.includes("\u0000")) {
    return {
      fallback: (
        <EmptyState title="Binary file" subtitle="There's nothing to display for this file." />
      ),
    };
  }
  if (text === "") return { fallback: <EmptyState title="Empty file" /> };
  return { text };
}

/** An unchanged file's current contents (from the working tree). */
function PlainFileView() {
  const { selectedFile } = useTrees();
  const result = useFileText();
  if ("fallback" in result) return result.fallback;
  return <CodeView path={selectedFile ?? ""} content={result.text} />;
}

/** A markdown file, rendered. Always the working-tree text — even for a changed
 *  file, where the diff is the other half of the toggle: a preview of a patch
 *  isn't a thing, and "what does this look like now" is the question the toggle
 *  is for. */
function MarkdownPreview() {
  const result = useFileText();
  if ("fallback" in result) return result.fallback;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-6 py-5">
        <MarkdownDocument>{result.text}</MarkdownDocument>
      </div>
    </div>
  );
}
