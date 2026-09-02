/**
 * The right-click menu on a sidebar worktree row.
 *
 * These act on the worktree as a *place on disk* — where to open it, what its
 * path and branch are, whether it should still exist — rather than on the work
 * happening inside it. That's why they hang off the row that names it instead of a header
 * above the workspace: they're reachable from any view, on any worktree, without
 * opening it first, which is also what let the workspace header go away.
 *
 * Openers are listed flat rather than behind an "Open in ▸" submenu — a submenu
 * costs a second hover to reach a list that is usually two or three rows — with
 * the configured default editor first, so the muscle-memory pick stays at the top.
 * The repo's primary checkout has no Delete: it is the repo, not a workspace.
 */
import { useState } from "react";

import type { Worktree } from "../../bindings";
import { OpenerIcon } from "../../features/trees/openerIcons";
import { useWorktreeDeletion } from "../../features/trees/useWorktreeDeletion";
import {
  TREES_DEFAULT_EDITOR_KEY,
  useOpeners,
  useOpenInApp,
  useResolvedSetting,
} from "../../lib/queries";
import { BranchIcon, CopyIcon, TrashIcon } from "../icons";
import { copyText } from "../menuRows";
import { ConfirmDialog, ContextMenu, type ContextMenuItem } from "../primitives";

export function WorktreeMenu({
  repo,
  worktree,
  primary,
  children,
}: {
  repo: string;
  worktree: Worktree;
  /** The repo's default-branch checkout — deletable only as a repo, not here. */
  primary: boolean;
  children: React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const { data: openers = [] } = useOpeners();
  const { mutate: openIn } = useOpenInApp();
  const { data: defaultKey } = useResolvedSetting(repo, TREES_DEFAULT_EDITOR_KEY);
  const { deleteWorktree } = useWorktreeDeletion(repo);

  const installed = openers.filter((o) => o.available);
  const ranked = [
    ...installed.filter((o) => o.key === defaultKey),
    ...installed.filter((o) => o.key !== defaultKey),
  ];

  const items: ContextMenuItem[] = [
    ...(ranked.length > 0
      ? ([{ kind: "heading", key: "open-in", label: "Open in" }] as ContextMenuItem[])
      : []),
    ...ranked.map(
      (opener): ContextMenuItem => ({
        kind: "action",
        key: opener.key,
        label: opener.label,
        icon: <OpenerIcon openerKey={opener.key} />,
        run: () => openIn({ path: worktree.path, opener: opener.key }),
      }),
    ),
    { kind: "rule", key: "rule-path" },
    {
      kind: "action",
      key: "copy-path",
      label: "Copy path",
      icon: <CopyIcon size={13} />,
      run: () => copyText(worktree.path, "Path"),
    },
    // The branch used to have its own line on the row and lost it: it repeats
    // the title in kebab-case, and it is the longest string in a rail this
    // narrow. What it was actually good for was pasting somewhere, which is
    // this — beside the path, the other fact about where the work lives.
    {
      kind: "action",
      key: "copy-branch",
      label: "Copy branch",
      icon: <BranchIcon size={13} />,
      run: () => copyText(worktree.branch, "Branch"),
    },
    ...(primary
      ? []
      : ([
          { kind: "rule", key: "rule-delete" },
          {
            kind: "action",
            key: "delete",
            label: "Delete",
            icon: <TrashIcon size={13} />,
            danger: true,
            run: () => setConfirming(true),
          },
        ] as ContextMenuItem[])),
  ];

  return (
    <>
      <ContextMenu items={items}>{children}</ContextMenu>
      <ConfirmDialog
        open={confirming}
        danger
        title="Delete worktree"
        confirmLabel="Delete"
        message={
          <>
            Delete the worktree for <span className="font-mono text-fg-2">{worktree.id}</span> and
            its branch <span className="font-mono text-fg-2">{worktree.branch}</span>? Any
            uncommitted changes will be lost.
          </>
        }
        // Optimistic + background: fire and close immediately — the row vanishes
        // now; the git removal runs in the background (rolls back + toasts on error).
        onConfirm={() => {
          deleteWorktree(worktree.id);
          return Promise.resolve();
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}
