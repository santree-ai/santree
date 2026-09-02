/**
 * The Tickets page's right rail: the focused ticket and the launch queue, on the
 * same {@link SidePanel} shell Trees, Reviews and Triage are built on — its
 * strip, its toggle, its edge resize and its collapse-by-shove.
 *
 * Two panes. The ticket ({@link IssuePanel}) is the ticket as a whole: header,
 * run control, blockers, the Linear body and thread, the notes. The queue
 * ({@link QueuePane}) is what will launch and how. The queue's tab carries the
 * shell's accent dot while there is anything in it — the strip's rule for a
 * count — and, for a beat after each add, a `+N` in the dot's place, so filling
 * the queue from the list or the graph is visibly landing somewhere.
 *
 * Collapsed, the shell draws nothing, and the page header's trailing edge takes
 * the toggle over (see `TicketsView`) — the handoff Trees makes to its tab bar.
 */
import { useEffect, useState } from "react";

import { LinearLogo, QueueIcon } from "../../components/icons";
import { SidePanel, type SidePanelTab } from "../../components/SidePanel";
import { IssuePanel } from "./IssuePanel";
import { QUEUE_BURST_MS, type RailTab, useIssues } from "./model";
import { QueuePane } from "./QueuePane";

const MIN_W = 264;
const MAX_W = 560;
/** Must match the model's default width. */
const DEFAULT_W = 304;

/** "+N" while the last burst of adds is fresh. A timer re-renders once it has
 *  gone stale, so the bubble leaves on its own. */
function useBurstLabel(): string | null {
  const { queueBurst } = useIssues();
  const [, tick] = useState(0);
  const fresh = queueBurst !== null && Date.now() - queueBurst.at < QUEUE_BURST_MS;
  useEffect(() => {
    if (!queueBurst) return;
    const left = QUEUE_BURST_MS - (Date.now() - queueBurst.at);
    if (left <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [queueBurst]);
  return fresh && queueBurst ? `+${queueBurst.count}` : null;
}

export function RightPanel() {
  const {
    rightCollapsed,
    rightWidth,
    setRightWidth,
    toggleRightPanel,
    railTab,
    setRailTab,
    selectedEligible,
  } = useIssues();
  const burst = useBurstLabel();

  const tabs: SidePanelTab<RailTab>[] = [
    { tab: "issue", label: "Linear ticket", icon: <LinearLogo size={13} /> },
    {
      tab: "queue",
      label: "Launch queue",
      icon: <QueueIcon size={15} />,
      dot: selectedEligible.length > 0 ? "var(--accent)" : null,
      badge: burst,
    },
  ];

  return (
    <SidePanel
      tabs={tabs}
      active={railTab}
      onSelect={setRailTab}
      collapsed={rightCollapsed}
      onToggle={toggleRightPanel}
      width={rightWidth}
      onWidth={setRightWidth}
      cssVar="--issues-right"
      min={MIN_W}
      max={MAX_W}
      resetTo={DEFAULT_W}
      ariaLabel="Ticket panel"
    >
      {railTab === "issue" ? <IssuePanel /> : <QueuePane />}
    </SidePanel>
  );
}
