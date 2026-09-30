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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Worktree, WorktreePr } from "../../bindings";
import { OpenerIcon } from "../../features/trees/openerIcons";
import { useWorktreeDeletion } from "../../features/trees/useWorktreeDeletion";
import {
  TREES_DEFAULT_EDITOR_KEY,
  useOpeners,
  useOpenInApp,
  useRepoReach,
  useResolvedSetting,
} from "../../lib/queries";
import { useAppUi } from "../../state/AppContext";
import { BranchIcon, CopyIcon, GitHubLogo, TrashIcon } from "../icons";
import { copyText } from "../menuRows";
import { primaryPr } from "../PrChip";
import { ConfirmDialog, ContextMenu, type ContextMenuItem } from "../primitives";

export function WorktreeMenu({
  repo,
  worktree,
  prs,
  primary,
  actionsDisabled,
  children,
}: {
  repo: string;
  worktree: Worktree;
  /** The PRs linked to the worktree; the open one, else the first, is copied. */
  prs: WorktreePr[];
  /** The repo's default-branch checkout — deletable only as a repo, not here. */
  primary: boolean;
  /** Why the checkout can't be changed from here (a Daedalus project: out of
   *  reach, or not yet). Set, Split and Delete stay listed but disabled with this
   *  as their tooltip; copying what the row already knows still works. */
  actionsDisabled?: string;
  children: React.ReactNode;
}) {
  const { remote } = useRepoReach(repo);
  const navigate = useNavigate();
  const { requestTreeFocus } = useAppUi();
  const [confirming, setConfirming] = useState(false);
  const { data: openers = [] } = useOpeners();
  const { mutate: openIn } = useOpenInApp();
  const { data: defaultKey } = useResolvedSetting(repo, TREES_DEFAULT_EDITOR_KEY);
  const { deleteWorktree } = useWorktreeDeletion(repo);

  const pr = primaryPr(prs);
  // A Daedalus checkout is a folder on the box: nothing on this Mac can open it.
  const installed = remote ? [] : openers.filter((o) => o.available);
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
    ...(pr
      ? ([
          {
            kind: "action",
            key: "copy-pr-link",
            label: "Copy GitHub PR link",
            icon: <GitHubLogo size={12} />,
            run: () => copyText(pr.url, "PR link"),
          },
        ] satisfies ContextMenuItem[])
      : []),
    { kind: "rule", key: "rule-split" },
    {
      kind: "action",
      key: "split",
      label: "Split branch…",
      icon: <BranchIcon size={13} />,
      disabled: actionsDisabled !== undefined,
      title: actionsDisabled,
      run: () => {
        requestTreeFocus(repo, worktree.id, { split: true, fromSidebar: true });
        void navigate({ to: "/trees", search: { project: repo, tree: worktree.id } });
      },
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
            disabled: actionsDisabled !== undefined,
            title: actionsDisabled,
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
