/** The diff pane: renders the selected changed file's diff via {@link DiffViewer}.
 *  The split/unified layout is an app setting (Settings → Trees). */
import { EmptyState, Spinner } from "../../components/primitives";
import {
  TREES_DIFF_MODE_KEY,
  useSetting,
  useWorktreeFileDiff,
  useWorktreeFileSource,
  useWorktreeStatus,
} from "../../lib/queries";
import { DiffViewer } from "./DiffViewer";
import { useTrees } from "./model";

export function DiffPane() {
  const { repo, activeId, selectedFile } = useTrees();
  const { data: diffModeSetting } = useSetting("app", TREES_DIFF_MODE_KEY);
  const diffMode = diffModeSetting === "unified" ? "unified" : "split";
  const { data: status = [] } = useWorktreeStatus(repo, activeId);
  const file = status.find((f) => f.path === selectedFile);
  const untracked = file?.status === "Untracked";

  const { data: diff, isLoading } = useWorktreeFileDiff(
    repo,
    activeId,
    selectedFile ?? "",
    untracked,
  );
  const { data: source } = useWorktreeFileSource(repo, activeId, selectedFile ?? "");

  if (!selectedFile) {
    return (
      <EmptyState
        title="No file selected"
        subtitle="Pick a changed file from the Changes list to view its diff."
      />
    );
  }
  if (file?.binary) {
    return (
      <EmptyState title="Binary file" subtitle="There's no text diff to show for this file." />
    );
  }
  if (isLoading || diff === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <DiffViewer
        path={selectedFile}
        diff={diff}
        oldText={source?.oldText ?? ""}
        newText={source?.newText ?? ""}
        mode={diffMode}
      />
    </div>
  );
}
