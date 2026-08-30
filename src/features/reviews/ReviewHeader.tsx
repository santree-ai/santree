/**
 * The Reviews detail header: the PR's identity (repo · #number · branch · title ·
 * author · review decision · check rollup · diffstat) with its actions on the
 * right, over the reviewers and the editable label row. Shared by every detail tab
 * — it sits above the tab bar, not inside a tab.
 */

import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { Reviewer, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { AgentsIcon, BranchIcon, CopyIcon, GitHubLogo, PanelIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, Pill } from "../../components/primitives";
import { useCreateWorktree, useRepos, useWorktreePrs, useWorktrees } from "../../lib/queries";
import { useApp, useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import {
  accentActiveStyle,
  checkRollupMeta,
  mergeQueueMeta,
  reviewDecisionMeta,
} from "../../theme/colors";
import { useReviewsModel } from "./model";
import { PrLabels } from "./PrLabels";

/** Collision-free, path-safe id for a PR tree. GitHub owner/repo components are
 * already validated by the backend; lengths distinguish ambiguous joined slugs. */
export function reviewTreeId(pr: Pick<ReviewPr, "repo" | "number">): string {
  const [owner, name] = pr.repo.split("/");
  return `review-${owner.length}-${owner}-${name.length}-${name}-${pr.number}`;
}

export function ReviewHeader({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo, inbox } = useReviewsModel();
  const { setActiveRepo } = useApp();
  const { data: repos = [] } = useRepos();
  const targetRepo = repos.find(
    (candidate) => candidate.name.toLowerCase() === pr.repo.toLowerCase(),
  );
  const repoName = targetRepo?.name ?? "";
  const { data: worktrees = [] } = useWorktrees(repoName);
  const { data: worktreePrs = [] } = useWorktreePrs(repoName);
  const createTree = useCreateWorktree(repoName);
  const { addPendingLaunches, removePendingLaunch, requestTreeFocus } = useAppUi();
  const navigate = useNavigate();
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];
  const treeId = reviewTreeId(pr);
  const linkedTreeId = worktreePrs.find((candidate) => candidate.url === pr.url)?.issueId;
  const existingTree = worktrees.find(
    (worktree) => worktree.id === linkedTreeId || worktree.branch === pr.headRef,
  );
  const isMine = inbox?.mine.some((candidate) => candidate.id === pr.id) ?? false;

  const viewTree = () => {
    if (!targetRepo || !existingTree) return;
    setActiveRepo(targetRepo.name);
    requestTreeFocus(existingTree.id);
    navigate({ to: "/trees" });
  };

  const openAsTree = () => {
    if (!targetRepo || existingTree || isMine) return;
    // No project: a PR is not one, and the placeholder is merged straight into
    // the sidebar's worktree list, so a stand-in here opens a band of its own.
    addPendingLaunches([{ id: treeId, title: pr.title, project: null, agent: null }]);
    setActiveRepo(targetRepo.name);
    navigate({ to: "/trees" });
    createTree.mutate(
      {
        issueId: treeId,
        title: pr.title,
        launch: { type: "pr", prRepo: pr.repo, branch: pr.headRef },
        base: pr.baseRef || null,
        // Deliberately no agent: Trees owns provider choice through its
        // persisted `+` tabs.
        agent: null,
      },
      {
        onSuccess: (worktree) => {
          removePendingLaunch(treeId);
          requestTreeFocus(worktree.id);
        },
        onError: () => removePendingLaunch(treeId),
      },
    );
  };

  return (
    // Identity on the left, actions on the right; each row spans the full width
    // rather than stacking everything on one side.
    <div className="flex-none border-b border-hairline px-5 pt-3.5 pb-2">
      <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-2">
        <span className="font-mono text-[12px] text-muted-3">{pr.repo}</span>
        <span className="font-mono text-[12px]" style={{ color: "var(--accent)" }}>
          #{pr.number}
        </span>
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(pr.headRef);
              toast.success("Branch copied.");
            }}
            title={`Copy branch — ${pr.headRef}`}
            className="group flex min-w-0 max-w-[300px] cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 py-1 font-mono text-[10.5px] text-[color:var(--color-branch)] hover:border-line-strong"
          >
            <BranchIcon size={11} className="flex-none" />
            <span className="truncate">{pr.headRef}</span>
            <CopyIcon size={11} className="flex-none text-muted-3 group-hover:text-fg-2" />
          </button>
          {!isMine && existingTree && (
            <Button
              size="sm"
              onClick={viewTree}
              title="Show the existing tree"
              className="flex-none"
            >
              <BranchIcon size={11} />
              View tree
            </Button>
          )}
          {!isMine && !existingTree && targetRepo && (
            <Button
              size="sm"
              onClick={openAsTree}
              disabled={createTree.isPending}
              title="Open this PR as a tree"
              className="flex-none"
            >
              <BranchIcon size={11} />
              Open as tree
            </Button>
          )}
          {!isMine && !targetRepo && (
            <Button
              size="sm"
              disabled
              title={`Add ${pr.repo} as a local repository before opening this PR as a tree`}
              className="flex-none"
            >
              <BranchIcon size={11} />
              Open as tree
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => openUrl(pr.url)}
            title="Open on GitHub"
            className="flex-none"
          >
            <GitHubLogo size={11} />
            Open
          </Button>
          <button
            type="button"
            onClick={toggleInfo}
            aria-pressed={!infoCollapsed}
            title={`${infoCollapsed ? "Show" : "Hide"} details (⌘L)`}
            className="flex-none cursor-pointer rounded-md border border-line-2 bg-input p-1.5 hover:border-line-strong"
            style={infoCollapsed ? { color: "var(--color-muted-3)" } : accentActiveStyle()}
          >
            <PanelIcon size={13} />
          </button>
        </div>
      </div>
      <MarkdownTitle className="mb-2 block text-[16px] leading-[1.3] font-semibold text-fg-bright">
        {pr.title}
      </MarkdownTitle>
      <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
        <span className="flex items-center gap-1.5 text-muted-2">
          <Avatar name={pr.author} src={pr.authorAvatarUrl} size={16} />
          {pr.author}
        </span>
        <Pill color={decision.color} className="px-1.5 py-px text-[10px] font-medium">
          {decision.label}
        </Pill>
        {pr.isInMergeQueue && (
          <Pill color={mergeQueueMeta.color} className="px-1.5 py-px text-[10px] font-medium">
            {mergeQueueMeta.glyph} {mergeQueueMeta.label}
          </Pill>
        )}
        <span className="flex items-center gap-1 font-mono" style={{ color: checks.color }}>
          {checks.glyph} {checks.label}
        </span>
        <span className="ml-auto font-mono text-muted-3">
          <span className="text-status-green">+{pr.additions}</span>{" "}
          <span className="text-status-red">−{pr.deletions}</span>
        </span>
      </div>
      {pr.reviewers.length > 0 && <Reviewers reviewers={pr.reviewers} />}
      <PrLabels pr={pr} />
    </div>
  );
}

/** Requested reviewers on the PR — people as avatar+login chips, teams as a
 *  bordered chip with a people glyph. */
function Reviewers({ reviewers }: { reviewers: Reviewer[] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[11px]">
      <span className="text-muted-4">Reviewers</span>
      {reviewers.map((r) =>
        r.kind === "User" ? (
          <span key={`u:${r.name}`} className="flex items-center gap-1 text-muted-2">
            <Avatar name={r.name} src={r.avatarUrl} size={15} />
            {r.name}
          </span>
        ) : (
          <span
            key={`t:${r.name}`}
            className="flex items-center gap-1 rounded-md border border-line-2 bg-input px-1.5 py-0.5 text-[10px] text-muted-2"
            title={`Team: ${r.name}`}
          >
            <AgentsIcon size={11} />
            {r.name}
          </span>
        ),
      )}
    </div>
  );
}
