/**
 * The Reviews detail header: the PR's identity (repo · #number · branch · title ·
 * author · review decision · check rollup · diffstat) with its actions on the
 * right, over the reviewers and the editable label row. Shared by every detail tab
 * — it sits above the tab bar, not inside a tab.
 */

import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { AgentKind, Reviewer, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { AgentsIcon, BranchIcon, CopyIcon, GitHubLogo, PanelIcon } from "../../components/icons";
import { Button, Pill } from "../../components/primitives";
import { useCreateReviewWorktree, useResolvedSetting, WORK_AGENT_KEY } from "../../lib/queries";
import { useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import {
  accentActiveStyle,
  checkRollupMeta,
  mergeQueueMeta,
  reviewDecisionMeta,
} from "../../theme/colors";
import { useReviewsModel } from "./model";
import { PrLabels } from "./PrLabels";

export function ReviewHeader({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo } = useReviewsModel();
  const { repo } = useReviewsModel();
  const { data: configuredAgent } = useResolvedSetting(repo, WORK_AGENT_KEY);
  const agent = (configuredAgent as AgentKind | null) ?? "Codex";
  const createTree = useCreateReviewWorktree(repo);
  const { addPendingLaunches, removePendingLaunch, requestTreeFocus } = useAppUi();
  const navigate = useNavigate();
  const decision = reviewDecisionMeta[pr.reviewDecision];
  const checks = checkRollupMeta[pr.checks];
  const treeId = `review-${pr.repo}-${pr.number}`.replace(/[^A-Za-z0-9._-]+/g, "-");

  const openAsTree = () => {
    addPendingLaunches([{ id: treeId, title: pr.title, project: "Reviews", agent }]);
    navigate({ to: "/trees" });
    createTree.mutate(
      {
        id: treeId,
        title: pr.title,
        branch: pr.headRef,
        base: pr.baseRef || null,
        agent,
      },
      {
        onSuccess: (worktree) => requestTreeFocus(worktree.id),
        onError: () => removePendingLaunch(treeId),
      },
    );
  };

  return (
    // Identity on the left, actions on the right; each row spans the full width
    // rather than stacking everything on one side.
    <div className="flex-none border-b border-hairline px-5 pt-3.5 pb-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[12px] text-muted-3">{pr.repo}</span>
        <span className="font-mono text-[12px]" style={{ color: "var(--accent)" }}>
          #{pr.number}
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
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
          <Button
            size="sm"
            onClick={openAsTree}
            title="Open this PR as a tree"
            className="flex-none"
          >
            <BranchIcon size={11} />
            Open as tree
          </Button>
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
      <h1 className="mb-2 text-[16px] leading-[1.3] font-semibold text-fg-bright">{pr.title}</h1>
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
