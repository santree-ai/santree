/** The diff pane: renders the selected changed file's diff via {@link DiffViewer}.
 *  The split/unified layout is an app setting (Settings → Trees). */
import { EmptyState, Spinner } from "../../components/primitives";
import {
  TREES_DIFF_MODE_KEY,
  useResolvedSetting,
  useWorktreeFileDiff,
  useWorktreeFileSource,
  useWorktreeStatus,
} from "../../lib/queries";
import { DiffViewer } from "./DiffViewer";
import { useTrees } from "./model";

export function DiffPane() {
  const { repo, activeId, selectedFile } = useTrees();
  // Repo override first, app default second — Settings → Trees offers both.
  const { data: diffModeSetting } = useResolvedSetting(repo, TREES_DIFF_MODE_KEY);
  const diffMode = diffModeSetting === "unified" ? "unified" : "split";
  const { data: status = [], isFetched: statusFetched } = useWorktreeStatus(repo, activeId);
  const file = status.find((f) => f.path === selectedFile);
  const untracked = file?.status === "Untracked";

  // Withhold the diff fetch until status has resolved at least once — otherwise
  // `untracked` defaults to false before `file` is known, the diff query runs
  // against the wrong (tracked) code path, and an untracked file flashes "No
  // changes in this file" until the second, correct fetch lands.
  const { data: diff, isLoading } = useWorktreeFileDiff(
    repo,
    activeId,
    selectedFile ?? "",
    untracked,
    statusFetched,
  );
  const { data: source } = useWorktreeFileSource(repo, activeId, selectedFile ?? "");

  if (!selectedFile) {
    return (
      <EmptyState
        title="No file selected"
        subtitle="Pick a changed file from the Changes list."
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
