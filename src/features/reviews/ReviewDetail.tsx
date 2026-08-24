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
import { AgentIcon, PlusIcon } from "../../components/icons";
import { Badge, Dropdown, EmptyState, MENU_ITEM, Tabs } from "../../components/primitives";
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
  /** Show a rail tab, un-collapsing the rail if it's hidden — the one entry point,
   *  so a caller can't leave the user staring at a tab they can't see. */
  const openPanel = (tab: PanelTab) => {
    setPanelTab(tab);
    if (infoCollapsed) toggleInfo();
  };

  return (
    <div className="flex min-w-0 flex-1">
      <PrPane pr={pr} />
      <PrInfoPanel pr={pr} tab={panelTab} onTabChange={openPanel} />
    </div>
  );
}

function PrPane({ pr }: { pr: ReviewPr }) {
  const { repo, fileFocus, aiReviewRequest } = useReviewsModel();
  const [tab, setTab] = useState<DetailTab>("pr");
  const [mountedProviders, setMountedProviders] = useState<AgentKind[]>([]);
  const checks = checkRollupMeta[pr.checks];
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const { data: configuredAgent } = useResolvedSetting(repo, REVIEW_AGENT_KEY);
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth();
  const codexAccount = useCodexAccount();
  const codexReady = !!codexHealth.data?.available && !!codexAccount.data?.connected;
  const defaultAgent = (configuredAgent as AgentKind | null) ?? "Codex";
  const termKey = aiReviewTermKey(pr);
  const { data: storedProviders = [] } = useSessionProviders(repo, termKey);
  const providers = REVIEW_AGENTS.filter(
    (agent) => storedProviders.includes(agent) || mountedProviders.includes(agent),
  );
  const openReview = useCallback((agent: AgentKind) => {
    setMountedProviders((current) => (current.includes(agent) ? current : [...current, agent]));
    setTab(agent);
  }, []);

  // The brief's rail is visible from every tab, so a jump from it has to bring the
  // diff back with it — otherwise clicking a reading-order entry from Checks looks
  // like nothing happened.
  useEffect(() => {
    if (fileFocus) setTab("pr");
  }, [fileFocus]);

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
            ...providers.map((agent) => ({
              value: agent as DetailTab,
              label: agentProvider(agent).label,
              icon: <AgentIcon kind={agent} size={11} />,
              badge: drafts?.length ? (
                <Badge color={palette.purple}>{drafts.length}</Badge>
              ) : undefined,
            })),
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
