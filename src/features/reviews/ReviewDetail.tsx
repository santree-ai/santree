/**
 * Right pane of the Reviews tab. A shared header ({@link ReviewHeader}: repo ·
 * #number · branch · open) sits above two tabs — **Pull request** (the per-file
 * diff with inline review comments) and **Checks** (the head commit's CI, with
 * "Fix CI with AI") — beside the {@link PrInfoPanel} rail, which carries the
 * reading material: the description and conversation, the linked ticket, and the
 * Ask AI session.
 *
 * The split is by *what you do with it*: the two main tabs are the change itself,
 * the rail is everything you consult while reading it. Keeping the ticket and the
 * AI beside the diff instead of replacing it is the whole point — reading a PR
 * against its ticket used to mean flipping away from the code.
 *
 * Panel tab and "has the AI been opened" live here rather than in the view model
 * because this subtree is keyed by PR: clicking a different PR must not carry the
 * Ask AI tab over with it and spawn a session for a PR the user only glanced at.
 */
import { useEffect, useState } from "react";

import type { ReviewPr } from "../../bindings";
import { EmptyState, Tabs } from "../../components/primitives";
import { checkRollupMeta } from "../../theme/colors";
import { ChecksPane } from "./ChecksPane";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { type PanelTab, PrInfoPanel } from "./PrInfoPanel";
import { PrReviewPane } from "./PrReviewPane";
import { ReviewHeader } from "./ReviewHeader";

type DetailTab = "pr" | "checks";

export function ReviewDetail() {
  const { active, showMergeQueue } = useReviewsModel();

  if (showMergeQueue) return <MergeQueuePane />;

  if (!active) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-app">
        <EmptyState title="Select a pull request" subtitle="Pick one from the list on the left." />
      </div>
    );
  }
  // Keyed remount so per-PR query state, the active tabs, and scroll reset on switch.
  return <Detail key={active.id} pr={active} />;
}

function Detail({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo } = useReviewsModel();
  const [panelTab, setPanelTab] = useState<PanelTab>("description");
  // The AI pane spawns a PTY and checks the PR out — non-idempotent effects, so it
  // must never be unmounted and remounted by a tab switch (CLAUDE.md's gotcha). It
  // mounts on first open and then stays, hidden. Gated on an explicit open so
  // merely selecting a PR never costs a checkout.
  const [aiOpened, setAiOpened] = useState(false);

  /** Show a rail tab, un-collapsing the rail if it's hidden — the one entry point,
   *  so a caller can't leave the user staring at a tab they can't see. */
  const openPanel = (tab: PanelTab) => {
    if (tab === "ai") setAiOpened(true);
    setPanelTab(tab);
    if (infoCollapsed) toggleInfo();
  };

  return (
    <div className="flex min-w-0 flex-1">
      <PrPane pr={pr} onAskAi={() => openPanel("ai")} />
      <PrInfoPanel pr={pr} tab={panelTab} onTabChange={openPanel} aiOpened={aiOpened} />
    </div>
  );
}

function PrPane({ pr, onAskAi }: { pr: ReviewPr; onAskAi: () => void }) {
  const { fileFocus } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  const checks = checkRollupMeta[pr.checks];

  // The brief's rail is visible from every tab, so a jump from it has to bring the
  // diff back with it — otherwise clicking a reading-order entry from Checks looks
  // like nothing happened.
  useEffect(() => {
    if (fileFocus) setTab("pr");
  }, [fileFocus]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <ReviewHeader pr={pr} onAskAi={onAskAi} />

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
        ]}
      />

      {tab === "pr" && <PrReviewPane pr={pr} fileFocus={fileFocus} />}
      {tab === "checks" && <ChecksPane pr={pr} />}
    </div>
  );
}
