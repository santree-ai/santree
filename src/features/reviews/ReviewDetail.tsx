/**
 * Right pane of the Reviews tab. A shared header ({@link ReviewHeader}: repo ·
 * #number · branch · open) sits above four tabs:
 *  - **Pull request** — the PR's per-file diff with inline review comments.
 *  - **Checks** — the head commit's CI checks, with "Fix CI with AI".
 *  - **Issue** — the linked Linear ticket, found from the PR title / branch (the
 *    same PR↔ticket convention the worktree flow uses) and rendered with the
 *    shared `DiscussionPane`, like the Trees "Issue" tab.
 *  - **Ask AI** — a Claude session that has read the PR and can answer questions
 *    about it. Read-only: it never comments or approves (see {@link AiReviewPane}).
 *
 * Each tab fetches lazily and shows a skeleton while loading; the header renders
 * immediately from the already-loaded list row.
 */
import { useEffect, useState } from "react";

import type { ReviewPr } from "../../bindings";
import { ClaudeSparkIcon } from "../../components/icons";
import { EmptyState, Tabs } from "../../components/primitives";
import { checkRollupMeta } from "../../theme/colors";
import { AiReviewPane } from "./AiReviewPane";
import { ChecksPane } from "./ChecksPane";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { PrInfoPanel } from "./PrInfoPanel";
import { PrReviewPane } from "./PrReviewPane";
import { ReviewHeader } from "./ReviewHeader";
import { ReviewIssuePane } from "./ReviewIssuePane";
import { ticketIdFor } from "./ticket";

type DetailTab = "pr" | "checks" | "issue" | "ai";

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
  const { repo: santreeRepo, fileFocus } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  // The AI pane spawns a PTY and checks the PR out — non-idempotent effects, so it
  // must never be unmounted and remounted by a tab switch (CLAUDE.md's gotcha).
  // It mounts on first open and then stays, hidden.
  const [aiOpened, setAiOpened] = useState(false);
  const ticketId = ticketIdFor(pr);
  const checks = checkRollupMeta[pr.checks];

  // The brief's rail is visible from every tab, so a jump from it has to bring the
  // diff back with it — otherwise clicking a reading-order entry from Checks looks
  // like nothing happened.
  useEffect(() => {
    if (fileFocus) setTab("pr");
  }, [fileFocus]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <ReviewHeader pr={pr} />

      <Tabs
        className="flex-none px-5"
        value={tab}
        onChange={(v) => {
          if (v === "ai") setAiOpened(true);
          setTab(v);
        }}
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
          { value: "ai", label: "Ask AI", badge: <ClaudeSparkIcon size={11} /> },
        ]}
      />

      {tab === "pr" && <PrReviewPane pr={pr} fileFocus={fileFocus} />}
      {tab === "checks" && <ChecksPane pr={pr} />}
      {tab === "issue" && <ReviewIssuePane repo={santreeRepo} ticketId={ticketId} />}
      {aiOpened && (
        <div className={tab === "ai" ? "flex min-h-0 flex-1" : "hidden"}>
          <AiReviewPane pr={pr} />
        </div>
      )}
    </div>
  );
}
