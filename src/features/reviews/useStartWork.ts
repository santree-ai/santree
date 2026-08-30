/**
 * "Start work" — hand the PR's open queue items to an agent.
 *
 * Two hosts, one difference: whether a worktree for this PR already exists. From
 * the Reviews tab it doesn't (you are looking at a PR, not a checkout), so one has
 * to be created and the app navigated to it. From the Trees tab the worktree *is*
 * what you are looking at, so the launch skips both.
 *
 * Everything after that is identical and stays here rather than in the two call
 * sites: `review_fix_launch` renders the prompt from the live items and returns
 * the capability paths, and `requestFixCiLaunch` hands them to the worktree, whose
 * provider opens (and persists) the "Address review" tab. The agent it starts runs
 * with commit/push denied — fixing is its job, sending is the user's.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { type AgentKind, commands, type ReviewPr, type TabPr } from "../../bindings";
import { queryKeys, REVIEW_AGENT_KEY, unwrap, useResolvedSetting } from "../../lib/queries";
import { useLaunchGuard } from "../../lib/useLaunchGuard";
import { useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { reviewTargetFor } from "./ReviewSessionShared";
import { ticketIdFor } from "./ticket";

/** The tab a "Start work" launch opens, in both hosts. */
const TAB_TITLE = "Address review";

/** The PR identity persisted with the tab. It is what the backend re-derives the
 *  session's `--settings` and `--mcp-config` from when the tab is reopened after a
 *  restart, once the in-memory hand-off below is gone. */
function tabPrFor(pr: ReviewPr): TabPr {
  return { repo: pr.repo, number: pr.number };
}

/** The agent a review launch runs as when the caller doesn't pick one: the repo's
 *  configured review agent, Claude if it has none. Both launches used to hardcode
 *  the literal `"Claude"` while the button beside them was *labelled* with this
 *  setting — so on a Codex repo the UI named one agent and ran another. */
function useDefaultReviewAgent(santreeRepo: string): AgentKind {
  const { data: configured } = useResolvedSetting(santreeRepo, REVIEW_AGENT_KEY);
  return (configured as AgentKind | null) ?? "Claude";
}

/** Start work on a PR from the Trees tab, where the worktree already exists.
 *
 *  The returned launcher takes an optional agent — a per-launch override, not a
 *  preference: it never writes {@link REVIEW_AGENT_KEY}, which Settings owns. */
export function useStartWorkInWorktree(pr: ReviewPr, worktreeId: string, santreeRepo: string) {
  const { requestFixCiLaunch } = useAppUi();
  const defaultAgent = useDefaultReviewAgent(santreeRepo);
  const guard = useLaunchGuard();

  return (agent?: AgentKind) => {
    if (!guard.take()) return;
    void (async () => {
      try {
        const launch = await unwrap(commands.reviewFixLaunch(santreeRepo, reviewTargetFor(pr)));
        requestFixCiLaunch({
          worktreeId,
          tabId: crypto.randomUUID(),
          promptPath: launch.promptPath,
          kind: "fixCi",
          pr: tabPrFor(pr),
          settingsPath: launch.settingsPath,
          mcpConfigPath: launch.mcpConfigPath,
          title: TAB_TITLE,
          agentKind: agent ?? defaultAgent,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't start the review fixes.");
      } finally {
        guard.release();
      }
    })();
  };
}

/**
 * Start the AI review on your own PR, from its worktree.
 *
 * Simpler than the Reviews tab's version of this, and better: there the session
 * has to build its own detached checkout of the PR (which is why that pane carries
 * a "diff only" warning and a "Remove checkout" button). Here the worktree *is*
 * the PR's head branch, so the agent gets the real repository for free.
 *
 * It runs as an ordinary agent tab in the main area, launched with the review
 * prompt, the deny-list settings and santree's review MCP server — the same three
 * paths the Reviews session uses, so the drafts it writes land in the same place.
 */
export function useStartAiReviewInWorktree(pr: ReviewPr, worktreeId: string, santreeRepo: string) {
  const { requestFixCiLaunch } = useAppUi();
  const defaultAgent = useDefaultReviewAgent(santreeRepo);
  const guard = useLaunchGuard();

  return (agent?: AgentKind) => {
    if (!guard.take()) return;
    void (async () => {
      try {
        const launch = await unwrap(commands.aiReviewLaunch(santreeRepo, reviewTargetFor(pr)));
        requestFixCiLaunch({
          worktreeId,
          tabId: crypto.randomUUID(),
          promptPath: launch.promptPath,
          kind: "aiReview",
          pr: tabPrFor(pr),
          settingsPath: launch.settingsPath,
          mcpConfigPath: launch.mcpConfigPath,
          title: "AI review",
          agentKind: agent ?? defaultAgent,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't start the AI review.");
      } finally {
        guard.release();
      }
    })();
  };
}

/** Start work on a PR from the Reviews tab: create (or adopt) its worktree, go
 *  there, then launch. */
export function useStartWorkFromReviews(pr: ReviewPr, santreeRepo: string) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { requestFixCiLaunch, addPendingLaunches, removePendingLaunch } = useAppUi();
  const guard = useLaunchGuard();

  return () => {
    if (!guard.take()) return;
    const issueId = ticketIdFor(pr) ?? `pr-${pr.number}`;
    addPendingLaunches([{ id: issueId, title: pr.title, project: "Reviews", agent: "Claude" }]);
    navigate({ to: "/trees" });
    void (async () => {
      try {
        const worktree = await unwrap(
          commands.createWorktreeForPr(
            santreeRepo,
            pr.repo,
            issueId,
            pr.title,
            pr.headRef,
            null,
            "Claude",
          ),
        );
        await qc.invalidateQueries({ queryKey: queryKeys.worktrees(santreeRepo) });
        const launch = await unwrap(commands.reviewFixLaunch(santreeRepo, reviewTargetFor(pr)));
        requestFixCiLaunch({
          worktreeId: worktree.id,
          tabId: crypto.randomUUID(),
          promptPath: launch.promptPath,
          kind: "fixCi",
          pr: tabPrFor(pr),
          settingsPath: launch.settingsPath,
          mcpConfigPath: launch.mcpConfigPath,
          title: TAB_TITLE,
          agentKind: "Claude",
        });
      } catch (error) {
        // The placeholder only comes down on failure: on success the real
        // worktree replaces it, and clearing it here would flash the row away.
        guard.release();
        removePendingLaunch(issueId);
        toast.error(error instanceof Error ? error.message : "Couldn't start the review fixes.");
      }
    })();
  };
}
