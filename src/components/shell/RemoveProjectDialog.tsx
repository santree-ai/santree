/**
 * The confirmation for forgetting a registered project, from the sidebar's
 * project menu and from Settings → Repo.
 *
 * Optimistic like a worktree delete: confirming closes at once and the project
 * leaves the sidebar; a refusal (a terminal still running in it) puts it back
 * and toasts. A screen that names the project leaves for `/trees` first, so
 * nothing on screen keeps reading a project that is gone.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { useRemoveRepo } from "../../lib/queries";
import { ConfirmDialog } from "../primitives";

export function RemoveProjectDialog({
  repo,
  onClose,
}: {
  /** The project to remove. Mounted only while asking. */
  repo: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const openProject = useRouterState({
    select: (s) => (s.location.search as { project?: string }).project ?? null,
  });
  const { mutate: removeRepo } = useRemoveRepo();

  return (
    <ConfirmDialog
      open
      danger
      title="Remove project"
      confirmLabel="Remove"
      message={
        <>
          Remove <span className="font-mono text-fg-2">{repo}</span> from santree? Its settings,
          tabs and saved sessions here are forgotten. Files on disk are kept: the repository, its
          worktrees and its <span className="font-mono text-fg-2">.santree</span> folder.
        </>
      }
      onConfirm={() => {
        if (openProject === repo) void navigate({ to: "/trees" });
        removeRepo(repo);
        return Promise.resolve();
      }}
      onClose={onClose}
    />
  );
}
