/**
 * Right pane of the Reviews tab. A shared header ({@link ReviewHeader}: repo ·
 * #number · branch · open) sits above three tabs:
 *  - **Pull request** — the PR's per-file diff with inline review comments.
 *  - **Checks** — the head commit's CI checks, with "Fix CI with AI".
 *  - **Issue** — the linked Linear ticket, found from the PR title / branch (the
 *    same PR↔ticket convention the worktree flow uses) and rendered with the
 *    shared `DiscussionPane`, like the Trees "Issue" tab.
 *
 * Each tab fetches lazily and shows a skeleton while loading; the header renders
 * immediately from the already-loaded list row.
 */
import { useState } from "react";

import type { ReviewPr } from "../../bindings";
import { EmptyState, Tabs } from "../../components/primitives";
import { checkRollupMeta } from "../../theme/colors";
import { ChecksPane } from "./ChecksPane";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { PrInfoPanel } from "./PrInfoPanel";
import { PrReviewPane } from "./PrReviewPane";
import { ReviewHeader } from "./ReviewHeader";
import { ReviewIssuePane } from "./ReviewIssuePane";
import { ticketIdFor } from "./ticket";

type DetailTab = "pr" | "checks" | "issue";

export function ReviewDetail() {
  const { active, showMergeQueue } = useReviewsModel();

  if (showMergeQueue) return <MergeQueuePane />;

  if (!active) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        <EmptyState
          title="Select a pull request"
          subtitle="Pick a PR from the left to review it."
        />
      </div>
    );
  }
  // Keyed remount so per-PR query state, the active tab, and scroll reset on switch.
  // The info rail spans the whole detail area (header, tabs, body) alongside the
  // PR pane, so the description stays visible across every tab.
  return (
    <div key={active.id} className="flex min-w-0 flex-1">
      <PrPane pr={active} />
      <PrInfoPanel pr={active} />
    </div>
  );
}

function PrPane({ pr }: { pr: ReviewPr }) {
  const { repo: santreeRepo } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  const ticketId = ticketIdFor(pr);
  const checks = checkRollupMeta[pr.checks];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <ReviewHeader pr={pr} />

      <Tabs
        className="flex-none px-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "pr", label: "Pull request" },
          {
            value: "checks",
            label: "Checks",
            badge: (
              <span className="font-mono text-[11px]" style={{ color: checks.color }}>
                {checks.glyph}
              </span>
            ),
          },
          { value: "issue", label: "Issue", dimmed: !ticketId },
        ]}
      />

      {tab === "pr" && <PrReviewPane pr={pr} />}
      {tab === "checks" && <ChecksPane pr={pr} />}
      {tab === "issue" && <ReviewIssuePane repo={santreeRepo} ticketId={ticketId} />}
    </div>
  );
}
