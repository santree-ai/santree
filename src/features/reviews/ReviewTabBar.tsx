/** Reviews' main area: the pull request and everything you have open beside
 *  it, on the same {@link SplitWorkspace} Trees draws — a strip per split group,
 *  each over its active tab's content.
 *
 *  **The first tab is the view itself.** "Pull Request" is a deliberate exception
 *  to the rule that `worktree_tabs` rows are the whole set of what a workspace has
 *  open: it is not a persisted row, it is what this view *is*, so it always exists
 *  and carries no close ×. Everything after it is ordinary — the PR checkout's own
 *  tab rows (the same rows, with the same persistence, that Trees shows for that
 *  worktree), the PR's ticket when the rail's pane has been expanded into a
 *  "Linear" tab, and the AI review sessions.
 *
 *  The "+" honours the asymmetry between those two: an AI review brings its own
 *  detached checkout, so it is on offer for any pull request, while a terminal or
 *  an ordinary agent needs a directory to run in. With no checkout the menu offers
 *  to cut one — through the header's own "Open as tree" flow, not a second copy of
 *  it. */
import { type ReactNode, useCallback } from "react";

import type { AgentKind, ReviewPr, WorktreeTab } from "../../bindings";
import {
  AgentIcon,
  BranchIcon,
  GitHubLogo,
  TerminalIcon,
  TrackerLogo,
} from "../../components/icons";
import { MENU_ITEM } from "../../components/primitives";
import { PanelToggle } from "../../components/SidePanel";
import { SplitWorkspace } from "../../components/split/SplitWorkspace";
import type { StripTab } from "../../components/TabStrip";
import {
  useAgentAuth,
  useCodexAccount,
  useCodexHealth,
  useRepos,
  useReviewDrafts,
  useTicketProvider,
} from "../../lib/queries";
import { useDigitShortcuts } from "../../lib/useKeyboardShortcuts";
import { palette } from "../../theme/colors";
import { liveTabFor } from "../agents/registry";
import {
  useAgentTabViews,
  useConversationOffer,
  ViewSwitch,
  withViewRow,
} from "../conversation/viewMode";
import { agentProvider } from "../terminal/agentProvider";
import { useTerminals } from "../terminal/TerminalsContext";
import type { NewTabOpts } from "../trees/model";
import { useTabAccounts } from "../trees/useTabAccounts";
import { tabRefId, useTabSessions } from "../trees/useTabSessions";
import { useWebOff } from "../web/availability";
import { usePageLabels } from "../web/pageState";
import { useStripWebHost, WebMenuRow, webStripTab } from "../web/strip";
import { aiReviewTermKey, REVIEW_AGENTS, REVIEW_CHECKOUT_NOTE } from "./checkoutSource";
import { useReviewsModel } from "./model";
import { aiTab, checkoutTab, type ReviewMainTab, type ReviewTabs } from "./useReviewTabs";
import { useWorktreeGate } from "./WorktreeGate";

export function ReviewTabBar({
  pr,
  tabs,
  renderTab,
}: {
  pr: ReviewPr;
  tabs: ReviewTabs;
  /** A tab's content; `visible` is whether it is showing in its group. */
  renderTab: (tab: ReviewMainTab, visible: boolean) => ReactNode;
}) {
  const { infoCollapsed, toggleInfo, repo } = useReviewsModel();
  const provider = useTicketProvider(repo);
  const { data: drafts } = useReviewDrafts(pr.repo, pr.number);
  const { closeWithSession } = useTabSessions(tabs.checkout.worktreeId, tabs.rows, tabs.closeTab);
  const { menuFor, detailFor } = useTabAccounts(
    tabs.checkout.repo,
    tabs.checkout.worktreeId,
    tabs.rows,
  );
  // A Claude tab's Terminal/Conversation switch: in its menu and on its strip.
  const viewOf = useAgentTabViews();
  const offer = useConversationOffer(tabs.checkout.repo);
  const conversationKey = (row: WorktreeTab) =>
    offer.row(row) && tabs.checkout.worktreeId ? tabRefId(tabs.checkout.worktreeId, row.id) : null;
  // The AI review tabs' half of the same rule: a tab is its process, so the ✕
  // ends the PTY before the row is forgotten. Their sessions hang off the PR's
  // own surface rather than a `worktree_tabs` row, which is the only reason
  // `useTabSessions` can't do it for them too.
  const { tabs: sessions, close: endSession } = useTerminals();
  const closeReview = (agent: AgentKind) => {
    const live = liveTabFor(repo, aiReviewTermKey(pr), agent, sessions);
    if (live) endSession(live.key);
    tabs.closeReview(agent);
  };
  const pageLabel = usePageLabels();

  // Links printed in the checkout's terminals and its AI reviews, and its pages'
  // popups, open Web tabs in the checkout — the only place a row can live.
  const { addTab, select } = tabs;
  const worktreeId = tabs.checkout.worktreeId;
  useStripWebHost({
    surfaces: worktreeId ? [worktreeId, aiReviewTermKey(pr)] : [],
    rows: tabs.rows,
    addWeb: useCallback(
      (url: string, opts?: NewTabOpts) => addTab("web", undefined, { ...opts, url }),
      [addTab],
    ),
    closeTab: tabs.closeTab,
    show: useCallback((id: string) => select(checkoutTab(id)), [select]),
  });

  const items: StripTab<ReviewMainTab>[] = [
    { tab: "pr", label: "Pull Request", icon: <GitHubLogo size={11} className="text-muted-3" /> },
    ...tabs.rows.map((t) =>
      t.kind === "web"
        ? webStripTab(checkoutTab(t.id), t, pageLabel, () => tabs.closeTab(t.id))
        : {
            tab: checkoutTab(t.id),
            label: t.title,
            icon:
              t.kind === "terminal" ? (
                <TerminalIcon size={11} className="text-muted-3" />
              ) : (
                <AgentIcon kind={t.agentKind ?? "Claude"} size={11} className="text-muted-3" />
              ),
            onClose: () => closeWithSession(t),
            onRename: (title: string) => tabs.renameTab(t.id, title),
            menu: withViewRow(conversationKey(t), viewOf(conversationKey(t) ?? ""), menuFor(t)),
            detail: detailFor(t),
          },
    ),
    // The ticket, at reading width. Between the checkout's rows and the AI
    // reviews so that opening a review does not shift it — same place Trees
    // puts its own reference tabs.
    ...(tabs.issueViewOpen
      ? [
          {
            tab: "issueView" as const,
            label: provider,
            icon: <TrackerLogo provider={provider} size={11} className="text-muted-3" />,
            onClose: tabs.closeIssueView,
          },
        ]
      : []),
    ...tabs.providers.map((agent) => {
      const count = drafts?.filter((draft) => draft.agentKind === agent).length ?? 0;
      return {
        tab: aiTab(agent),
        label: `${agentProvider(agent).label} review`,
        icon: <AgentIcon kind={agent} size={11} className="text-muted-3" />,
        // Closable like any other agent tab: it *is* an agent with a review
        // prompt, so it ends the way the rest do — the ✕ stops the process and
        // forgets the stored session. What it wrote (drafts, brief) lives in
        // santree's own tables, and its transcript stays on disk, so the same
        // review reopens from Session history or from the "+" menu.
        onClose: () => closeReview(agent),
        // A badge, not the affordance slot: the ✕ owns that now, and a count
        // that vanished the moment the tab became closable would be worse than
        // no count at all.
        badge: count ? (
          <span className="text-2xs tabular-nums" style={{ color: palette.purple }}>
            {count}
          </span>
        ) : undefined,
      };
    }),
  ];

  return (
    <SplitWorkspace
      split={{ ...tabs.split, select: tabs.select }}
      items={items}
      renderTab={renderTab}
      ariaLabel="Pull request tabs"
      newTabMenu={(close) => <NewTabMenu tabs={tabs} close={close} />}
      groupTrailing={(tab) => {
        const row = tabs.rows.find((t) => checkoutTab(t.id) === tab);
        const key = row ? conversationKey(row) : null;
        return key ? <ViewSwitch termKey={key} /> : null;
      }}
      trailing={infoCollapsed ? <PanelToggle collapsed onToggle={toggleInfo} /> : null}
    />
  );
}

/** New-tab menu rows. Mounted only while the menu is open, so its digit-key
 *  listener is live exactly when the menu is visible — and numbered in the order
 *  the rows are actually offered, which depends on whether the PR is checked
 *  out. */
function NewTabMenu({ tabs, close }: { tabs: ReviewTabs; close: () => void }) {
  const claudeReady = !!useAgentAuth("Claude").data?.connected;
  const codexHealth = useCodexHealth().data;
  const codexAccount = useCodexAccount(codexHealth?.available === true).data;
  const codexReady = !!codexHealth?.available && !!codexAccount?.connected;
  const ready = (agent: AgentKind) => (agent === "Codex" ? codexReady : claudeReady);
  // Terminals and agents run in the PR's own worktree; a review reads whichever
  // checkout exists, including the hidden kind an earlier review cut.
  const checkedOut = tabs.checkout.worktree !== null;
  const reviewable = tabs.checkout.source.worktree !== null;
  const askForWorktree = useWorktreeGate();
  const onDaedalus =
    useRepos().data?.find((r) => r.name === tabs.checkout.repo)?.location === "Daedalus";
  const webOff = useWebOff(onDaedalus);

  const review = (agent: AgentKind) => {
    if (!ready(agent)) return;
    // An AI review reads real code, so it needs the PR checked out — and cutting
    // that checkout is the thing worth asking about. With one already on disk
    // there is nothing to ask: the review just opens.
    // Until both reads have answered, "nothing on disk" would be a guess (and
    // the dialog it opens a duplicate), so the click waits for them.
    if (!tabs.checkout.known) return;
    // Or one already open, still cutting its checkout: asking again would be a
    // second dialog for the create it is in the middle of.
    if (reviewable || tabs.mounted.includes(agent)) {
      tabs.openReview(agent);
      close();
      return;
    }
    close();
    void askForWorktree(`Reviewing with ${agentProvider(agent).label}`).then((choice) => {
      if (!choice.ok) return;
      // The session's own `useReviewWorkspace` does the creating — this is the
      // consent it now waits for, not a second create.
      tabs.openReview(agent, choice.runSetup);
    });
  };
  const work = (agent: AgentKind | null) => {
    if (agent && !ready(agent)) return;
    if (agent) tabs.addTab("agent", agent);
    else tabs.addTab("terminal");
    close();
  };
  const browse = () => {
    if (webOff) return;
    tabs.addTab("web");
    close();
  };
  const createCheckout = () => {
    tabs.checkout.openAsTree();
    close();
  };

  useDigitShortcuts([
    () => review("Codex"),
    () => review("Claude"),
    ...(checkedOut
      ? [() => work("Codex"), () => work("Claude"), () => work(null), browse]
      : [tabs.checkout.canOpen && !tabs.checkout.opening ? createCheckout : null]),
  ]);

  return (
    <>
      <MenuSection>Review with AI</MenuSection>
      {REVIEW_AGENTS.map((agent, i) => (
        <button
          key={agent}
          type="button"
          disabled={!ready(agent)}
          // Each provider names two rows, and the headings that tell them apart
          // are not read out. The name still opens with the visible label, so it
          // is the same control by voice.
          aria-label={`${agentProvider(agent).label} review`}
          title={
            ready(agent) ? undefined : `Connect ${agentProvider(agent).label} in Settings first`
          }
          onClick={() => review(agent)}
          className={MENU_ITEM}
        >
          <AgentIcon kind={agent} size={13} />
          {agentProvider(agent).label}
          <span className="ml-auto text-2xs text-muted-4">{i + 1}</span>
        </button>
      ))}
      {/* What the rows above put on disk. Said where the action is offered, not
          discovered afterwards in a directory listing. */}
      <p className="px-3 pt-1 pb-2 text-xs leading-4 text-muted-4">{REVIEW_CHECKOUT_NOTE}</p>
      <MenuSection>Work in the checkout</MenuSection>
      {checkedOut ? (
        <>
          {REVIEW_AGENTS.map((agent, i) => (
            <button
              key={agent}
              type="button"
              disabled={!ready(agent)}
              aria-label={`${agentProvider(agent).label} in the checkout`}
              title={
                ready(agent) ? undefined : `Connect ${agentProvider(agent).label} in Settings first`
              }
              onClick={() => work(agent)}
              className={MENU_ITEM}
            >
              <AgentIcon kind={agent} size={13} />
              {agentProvider(agent).label}
              <span className="ml-auto text-2xs text-muted-4">{i + 3}</span>
            </button>
          ))}
          <button type="button" onClick={() => work(null)} className={MENU_ITEM}>
            <TerminalIcon />
            Terminal
            <span className="ml-auto text-2xs text-muted-4">5</span>
          </button>
          <WebMenuRow off={webOff} digit={6} onAdd={browse} />
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={createCheckout}
            disabled={!tabs.checkout.canOpen || tabs.checkout.opening}
            title={
              tabs.checkout.canOpen
                ? "Cut a worktree from this PR's branch and open it"
                : "Add this PR's repository as a local project first"
            }
            className={MENU_ITEM}
          >
            <BranchIcon size={13} />
            Open as tree
            {tabs.checkout.canOpen && <span className="ml-auto text-2xs text-muted-4">3</span>}
          </button>
          {/* Not a disabled row per provider: the missing thing is the checkout,
              and saying it once is the whole answer. */}
          <p className="px-3 pb-2 text-xs leading-4 text-muted-4">
            Terminals and agents run in the PR's own checkout.
          </p>
        </>
      )}
    </>
  );
}

function MenuSection({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-4">{children}</div>;
}
