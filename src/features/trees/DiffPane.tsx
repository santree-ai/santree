/** The diff pane: renders the selected file's diff via {@link DiffViewer} — the
 *  working tree against HEAD, or, for a file picked from the "Committed on
 *  branch" list, the branch against its base. The split/unified layout is an app
 *  setting (Settings → Trees). */
import { useState } from "react";

import { EmptyState, TerminalActivity } from "../../components/primitives";
import {
  TREES_DIFF_MODE_KEY,
  usePrDetail,
  usePrSummary,
  useResolvedSetting,
  useWorktreeBranchChanges,
  useWorktreeBranchFileDiff,
  useWorktreeFileDiff,
  useWorktreeFileSource,
  useWorktreeStatus,
} from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { DiffViewer } from "./DiffViewer";
import { prDiffModeFor, useTrees } from "./model";
import { PrFileDiffPane } from "./PrFileDiffPane";
import { PrSyncNotice } from "./PrSyncNotice";

export function DiffPane() {
  const { repo, activeId, selectedFile, selectedFileScope } = useTrees();
  if (selectedFileScope === "branch") return <BranchDiffPane />;
  return <WorkingDiffPane repo={repo} activeId={activeId} selectedFile={selectedFile} />;
}

/** A committed file's diff.
 *
 *  Two sources, one surface. When the file is part of the worktree's pull request
 *  this renders GitHub's patch — which is what carries the review comments and
 *  what a new comment can anchor to. Otherwise (no PR, or a file the PR's capped
 *  list doesn't contain) it falls back to the local branch-vs-base diff, which is
 *  the same view this pane has always shown. No context expansion in that case:
 *  the old/new sources the viewer expands from are HEAD vs. working tree, which is
 *  a different diff. */
function BranchDiffPane() {
  const { repo, activeId, active, activePr, selectedFile } = useTrees();
  const { data: diffModeSetting } = useResolvedSetting(repo, TREES_DIFF_MODE_KEY);
  const diffMode = diffModeSetting === "unified" ? "unified" : "split";
  const { data: committed = [] } = useWorktreeBranchChanges(repo, activeId);
  const file = committed.find((f) => f.path === selectedFile);
  const { data: diff, isLoading } = useWorktreeBranchFileDiff(repo, activeId, selectedFile ?? "");
  const { data: summary } = usePrSummary(activePr?.repo ?? null, activePr?.number ?? 0);
  const [owner, name] = splitRepoSlug(activePr?.repo ?? "");
  const { data: detail } = usePrDetail(owner, name, activePr?.number ?? 0, !!activePr);
  // Per file: the notice is dismissed by choosing to read the PR's version of
  // *this* file, which says nothing about the next one.
  const [forcePr, setForcePr] = useState<string | null>(null);

  if (!selectedFile) {
    return <EmptyState title="No file selected" subtitle="Pick a committed file from the list." />;
  }
  if (file?.binary) {
    return (
      <EmptyState title="Binary file" subtitle="There's no text diff to show for this file." />
    );
  }

  const prFile = (detail?.files ?? []).find((f) => f.path === selectedFile);
  const mode = prDiffModeFor({ inPr: !!prFile && !!summary, unpushed: active?.unpushed ?? 0 });
  const showPr = mode === "pr" || (mode === "localAhead" && forcePr === selectedFile);

  if (showPr && prFile && summary) {
    return <PrFileDiffPane pr={summary} file={prFile} path={selectedFile} />;
  }

  if (isLoading || diff === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <TerminalActivity label="Loading diff…" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mode === "localAhead" && active && (
        <PrSyncNotice worktree={active} onShowPrVersion={() => setForcePr(selectedFile)} />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <DiffViewer path={selectedFile} diff={diff} oldText="" newText="" mode={diffMode} />
      </div>
    </div>
  );
}

function WorkingDiffPane({
  repo,
  activeId,
  selectedFile,
}: {
  repo: string;
  activeId: string;
  selectedFile: string | null;
}) {
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
      <EmptyState title="No file selected" subtitle="Pick a changed file from the Changes list." />
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
        <TerminalActivity label="Loading diff…" />
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
