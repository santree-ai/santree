/**
 * Right pane of the Reviews tab. A shared header ({@link ReviewHeader}: repo ·
 * #number · branch · open) sits above three tabs — **Pull request** (the per-file
 * diff with inline review comments), **Checks** (the head commit's CI, with
 * "Fix CI with AI") and **AI review** (the session that writes draft comments into
 * the diff) — beside the {@link PrInfoPanel} rail, which carries the reading
 * material: the description, conversation, and linked ticket.
 *
 * The split is by *what you do with it*: the two main tabs are the change itself,
 * the rail is everything you consult while reading it. Keeping the ticket beside
 * the diff instead of replacing it is the whole point — reading a PR
 * against its ticket used to mean flipping away from the code.
 *
 */
import { useCallback, useEffect, useState } from "react";

import type { AgentKind, ReviewPr } from "../../bindings";
import { AgentIcon, PlusIcon, PrIcon, SparklesIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Badge, Dropdown, MENU_ITEM, Tabs } from "../../components/primitives";
import { PriorityBars } from "../../components/WorkSignals";
import {
  REVIEW_AGENT_KEY,
  useAgentAuth,
  useCodexAccount,
  useCodexHealth,
  useResolvedSetting,
  useReviewDrafts,
  useSessionProviders,
} from "../../lib/queries";
import { checkRollupMeta, palette } from "../../theme/colors";
import { agentProvider } from "../terminal/agentProvider";
import { AiReviewSessionPane, aiReviewTermKey } from "./AiReviewSessionPane";
import { ChecksPane } from "./ChecksPane";
import { splitByStance, waitingDays, waitingLabel } from "./grouping";
import { MergeQueuePane } from "./MergeQueuePane";
import { useReviewsModel } from "./model";
import { type PanelTab, PrInfoPanel } from "./PrInfoPanel";
import { PrReviewPane } from "./PrReviewPane";
import { ReviewHeader } from "./ReviewHeader";

type DetailTab = "pr" | "checks" | AgentKind;
const REVIEW_AGENTS: AgentKind[] = ["Codex", "Claude"];

export function ReviewDetail() {
  const { active, showMergeQueue } = useReviewsModel();

  if (showMergeQueue) return <MergeQueuePane />;

  if (!active) {
    return <ReviewsHome />;
  }
  // Keyed remount so per-PR query state, the active tabs, and scroll reset on switch.
  return <Detail key={active.id} pr={active} />;
}

/** Inbox landing surface. Selection stays deliberate while the largest pane
 * answers the useful first question: what should I review next? */
function ReviewsHome() {
  const { inbox, loading, allPrs, ticketFor, setActive, openMergeQueue } = useReviewsModel();
  const requested = [
    ...new Map(
      [...(inbox?.requested ?? []), ...(inbox?.teams.flatMap((t) => t.prs) ?? [])].map((pr) => [
        pr.id,
        pr,
      ]),
    ).values(),
  ];
  const waiting = splitByStance(requested).waiting;
  const next = [...waiting].sort((a, b) => waitingDays(b) - waitingDays(a)).slice(0, 4);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10">
        <div className="w-full max-w-[720px]">
          <div className="mb-7 flex items-start gap-4">
            <span className="flex h-11 w-11 flex-none items-center justify-center rounded-[var(--radius-lg)] border border-line-2 bg-raised text-accent">
              <PrIcon size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[18px] font-semibold tracking-[-.01em] text-fg-bright">
                Review inbox
              </h1>
              <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-muted-3">
                Pick up the oldest request, check your open work, or inspect the merge queue.
              </p>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-3 divide-x divide-line overflow-hidden rounded-[var(--radius-md)] border border-line bg-raised">
            <SummaryStat label="Needs review" value={waiting.length} />
            <SummaryStat label="My PRs" value={inbox?.mine.length ?? 0} />
            <button
              type="button"
              onClick={openMergeQueue}
              className="cursor-pointer px-4 py-3 text-left hover:bg-hover"
            >
              <span className="block font-mono text-[15px] text-fg-bright">queue</span>
              <span className="mt-0.5 block text-[10.5px] text-muted-4">merge status</span>
            </button>
          </div>

          {loading ? (
            <div className="py-8 text-center font-mono text-[11px] text-muted-4">
              ······ loading
            </div>
          ) : next.length > 0 ? (
            <div>
              <div className="mb-2 font-mono text-[9px] tracking-[.08em] text-muted-4 uppercase">
                Pick up next
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {next.map((pr) => {
                  const ticket = ticketFor(pr);
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => setActive(pr.id)}
                      className="entity-card cursor-pointer p-3 text-left"
                    >
                      <span className="flex items-center gap-2 font-mono text-[9.5px] text-muted-4">
                        <span>#{pr.number}</span>
                        {ticket?.priority !== undefined && ticket.priority !== "None" && (
                          <PriorityBars priority={ticket.priority} />
                        )}
                        <span className="ml-auto">{waitingLabel(waitingDays(pr))}</span>
                      </span>
                      <MarkdownTitle className="mt-1.5 block line-clamp-2 text-[11.5px] leading-4 text-fg-2">
                        {pr.title}
                      </MarkdownTitle>
                      {pr.aiDraftCount > 0 && (
                        <span
                          className="mt-2 flex items-center gap-1 font-mono text-[9px]"
                          style={{ color: palette.purple }}
                        >
                          <SparklesIcon size={9} /> {pr.aiDraftCount} AI draft
                          {pr.aiDraftCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-[var(--radius-md)] border border-line bg-raised px-4 py-5 text-[12px] text-muted-3">
              No review requests are waiting. You can still open one of your {allPrs.length} visible
              pull requests from the sidebar.
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 font-mono text-[10px] text-muted-4">
            <span>
              <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘K</kbd>
              find anything
            </span>
            <span>
              <kbd className="mr-1.5 rounded border border-line-2 bg-input px-1.5 py-0.5">⌘B</kbd>
              sidebar
            </span>
            <span className="ml-auto">select a pull request to open its diff</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3">
      <span className="block font-mono text-[15px] text-fg-bright">{value}</span>
      <span className="mt-0.5 block text-[10.5px] text-muted-4">{label}</span>
    </div>
  );
}

function Detail({ pr }: { pr: ReviewPr }) {
  const { infoCollapsed, toggleInfo } = useReviewsModel();
  const [panelTab, setPanelTab] = useState<PanelTab>("description");
  const [detailTab, setDetailTab] = useState<DetailTab>("pr");
  /** Show a rail tab, un-collapsing the rail if it's hidden — the one entry point,
   *  so a caller can't leave the user staring at a tab they can't see. */
  const openPanel = (tab: PanelTab) => {
    setPanelTab(tab);
    if (infoCollapsed) toggleInfo();
  };

  return (
    <div className="relative flex min-w-0 flex-1 overflow-hidden">
      <PrPane pr={pr} tab={detailTab} setTab={setDetailTab} />
      <PrInfoPanel
        pr={pr}
        tab={panelTab}
        onTabChange={openPanel}
        activeReviewAgent={detailTab === "Codex" || detailTab === "Claude" ? detailTab : null}
      />
    </div>
  );
}

function PrPane({
  pr,
  tab,
  setTab,
}: {
  pr: ReviewPr;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
}) {
  const { repo, fileFocus, aiReviewRequest } = useReviewsModel();
  const [mountedProviders, setMountedProviders] = useState<AgentKind[]>([]);
  const checks = checkRollupMeta[pr.checks];
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const { data: configuredAgent } = useResolvedSetting(repo, REVIEW_AGENT_KEY);
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth();
  const codexAccount = useCodexAccount(codexHealth.data?.available === true);
  const codexReady = !!codexHealth.data?.available && !!codexAccount.data?.connected;
  const defaultAgent = (configuredAgent as AgentKind | null) ?? "Claude";
  const termKey = aiReviewTermKey(pr);
  const { data: storedProviders = [] } = useSessionProviders(repo, termKey);
  const providers = REVIEW_AGENTS.filter(
    (agent) => storedProviders.includes(agent) || mountedProviders.includes(agent),
  );
  const openReview = useCallback(
    (agent: AgentKind) => {
      setMountedProviders((current) => (current.includes(agent) ? current : [...current, agent]));
      setTab(agent);
    },
    [setTab],
  );

  // The brief's rail is visible from every tab, so a jump from it has to bring the
  // diff back with it — otherwise clicking a reading-order entry from Checks looks
  // like nothing happened.
  useEffect(() => {
    if (fileFocus) setTab("pr");
  }, [fileFocus, setTab]);

  // "Start AI review" comes from the rail, which is beside this column rather than
  // in it. A nonce, so asking again on an already-open tab still brings it forward.
  useEffect(() => {
    if (!aiReviewRequest) return;
    openReview(defaultAgent);
  }, [aiReviewRequest, defaultAgent, openReview]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <ReviewHeader pr={pr} />

      <div className="flex flex-none items-stretch pr-5">
        <Tabs
          className="min-w-0 flex-1 px-5 pr-0"
          value={tab}
          onChange={(next) => {
            if (next === "Codex" || next === "Claude") openReview(next);
            else setTab(next);
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
            ...providers.map((agent) => {
              const count = drafts?.filter((draft) => draft.agentKind === agent).length ?? 0;
              return {
                value: agent as DetailTab,
                label: agentProvider(agent).label,
                icon: <AgentIcon kind={agent} size={11} />,
                badge: count ? <Badge color={palette.purple}>{count}</Badge> : undefined,
              };
            }),
          ]}
        />
        {providers.length < REVIEW_AGENTS.length && (
          <Dropdown
            align="right"
            menuClassName="w-44 overflow-hidden"
            trigger={(toggle) => (
              <button
                type="button"
                onClick={toggle}
                title="Review with another agent"
                aria-label="Review with another agent"
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-3 hover:bg-hover hover:text-fg-2"
              >
                <PlusIcon size={12} />
              </button>
            )}
          >
            {(close) =>
              REVIEW_AGENTS.filter((agent) => !providers.includes(agent)).map((agent) => (
                <button
                  key={agent}
                  type="button"
                  disabled={agent === "Codex" ? !codexReady : !claudeReady}
                  title={
                    (agent === "Codex" ? codexReady : claudeReady)
                      ? undefined
                      : `Connect ${agentProvider(agent).label} in Settings first`
                  }
                  className={MENU_ITEM}
                  onClick={() => {
                    openReview(agent);
                    close();
                  }}
                >
                  <AgentIcon kind={agent} size={13} />
                  {agentProvider(agent).label}
                </button>
              ))
            }
          </Dropdown>
        )}
      </div>

      {tab === "pr" && <PrReviewPane pr={pr} fileFocus={fileFocus} />}
      {tab === "checks" && <ChecksPane pr={pr} />}
      {mountedProviders.map((agent) => (
        <div key={agent} className={tab === agent ? "flex min-h-0 flex-1" : "hidden"}>
          <AiReviewSessionPane
            pr={pr}
            agentKind={agent}
            visible={tab === agent}
            onShowDrafts={() => setTab("pr")}
          />
        </div>
      ))}
    </div>
  );
}
