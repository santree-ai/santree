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
 *
 * **The tab opens first, the launch fills it in.** That render command fetches the
 * PR, writes the diff index and lays out three files — seconds during which a
 * click used to produce nothing at all: no tab, no busy button, and then an agent
 * already talking. So the hand-off goes out twice under one minted tab id
 * ({@link FixCiLaunch}): `preparing` before the first await, `ready` when the paths
 * land. The PTY still waits for the paths — an agent spawned against a stale MCP
 * config would anchor its comments off a stale diff index — but the waiting now
 * happens *in the tab*, saying what it is waiting for.
 */
import { useNavigate } from "@tanstack/react-router";

import {
  type AgentKind,
  type AiReviewLaunch,
  commands,
  type ReviewPr,
  type TabPr,
} from "../../bindings";
import {
  REVIEW_AGENT_KEY,
  unwrap,
  useCreateWorktree,
  usePromoteReviewWorktree,
  useResolvedSetting,
} from "../../lib/queries";
import { useLaunchGuard } from "../../lib/useLaunchGuard";
import { useOptionalAgentRuns } from "../../state/AgentRuns";
import { type FixCiLaunch, useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { reviewTreeId } from "./checkoutSource";
import type { PrCheckout } from "./PrCheckout";
import { reviewTargetFor } from "./ReviewSessionShared";
import { ticketIdFor } from "./ticket";
import { useWorktreeGate } from "./WorktreeGate";

/** The tab a "Start work" launch opens, in both hosts. */
const TAB_TITLE = "Address review";

/** What a trigger needs: the click, and whether its launch is still running.
 *  `starting` is what a button renders busy off — see {@link useLaunchGuard}. */
export interface StartWorkLauncher {
  start: (agent?: AgentKind) => void;
  starting: boolean;
}

/** The half of the hand-off that exists at the click: which tab, on which
 *  worktree, running what. Enough for Trees to open and focus the tab; the paths
 *  the session actually launches with arrive under the same id. */
type TabSeed = Omit<FixCiLaunch, "phase" | "promptPath" | "settingsPath" | "mcpConfigPath">;

/** The PR identity persisted with the tab. It is what the backend re-derives the
 *  session's `--settings` and `--mcp-config` from when the tab is reopened after a
 *  restart, once the in-memory hand-off below is gone. */
function tabPrFor(pr: ReviewPr): TabPr {
  return { repo: pr.repo, number: pr.number };
}

/** The second half: the same tab, now with everything its session launches with. */
function readyLaunch(seed: TabSeed, launch: AiReviewLaunch): FixCiLaunch {
  return {
    ...seed,
    phase: "ready",
    promptPath: launch.promptPath,
    settingsPath: launch.settingsPath,
    mcpConfigPath: launch.mcpConfigPath,
  };
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
 *  preference: it never writes {@link REVIEW_AGENT_KEY}, which Settings owns.
 *
 *  `pr` is undefined while the branch's PR summary is still being fetched: the
 *  panel that hosts these buttons builds the launcher a level above the pane that
 *  waits for it. Nothing can be launched against a PR we can't name yet, and no
 *  button that calls this renders until it resolves. */
export function useStartWorkInWorktree(
  pr: ReviewPr | undefined,
  worktreeId: string,
  santreeRepo: string,
): StartWorkLauncher {
  const { requestFixCiLaunch, abandonLaunchTab } = useAppUi();
  const defaultAgent = useDefaultReviewAgent(santreeRepo);
  const guard = useLaunchGuard();

  return {
    starting: guard.pending,
    start: (agent?: AgentKind) => {
      if (!pr || !guard.take()) return;
      // The worktree is already on screen, so nothing is unknown at the click:
      // the tab can be minted, opened and focused before the first await.
      const seed: TabSeed = {
        worktreeId,
        tabId: crypto.randomUUID(),
        kind: "fixCi",
        pr: tabPrFor(pr),
        title: TAB_TITLE,
        agentKind: agent ?? defaultAgent,
      };
      requestFixCiLaunch({ ...seed, phase: "preparing" });
      void (async () => {
        try {
          const launch = await unwrap(commands.reviewFixLaunch(santreeRepo, reviewTargetFor(pr)));
          requestFixCiLaunch(readyLaunch(seed, launch));
        } catch (error) {
          abandonLaunchTab(seed.tabId);
          toast.error(error instanceof Error ? error.message : "Couldn't start the review fixes.");
        } finally {
          guard.release();
        }
      })();
    },
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
 *
 * `pr` is undefined while its summary loads, for the same reason as above.
 */
export function useStartAiReviewInWorktree(
  pr: ReviewPr | undefined,
  worktreeId: string,
  santreeRepo: string,
): StartWorkLauncher {
  const { requestFixCiLaunch, abandonLaunchTab } = useAppUi();
  const defaultAgent = useDefaultReviewAgent(santreeRepo);
  const guard = useLaunchGuard();

  return {
    starting: guard.pending,
    start: (agent?: AgentKind) => {
      if (!pr || !guard.take()) return;
      const seed: TabSeed = {
        worktreeId,
        tabId: crypto.randomUUID(),
        kind: "aiReview",
        pr: tabPrFor(pr),
        title: "AI review",
        agentKind: agent ?? defaultAgent,
      };
      requestFixCiLaunch({ ...seed, phase: "preparing" });
      void (async () => {
        try {
          const launch = await unwrap(commands.aiReviewLaunch(santreeRepo, reviewTargetFor(pr)));
          requestFixCiLaunch(readyLaunch(seed, launch));
        } catch (error) {
          abandonLaunchTab(seed.tabId);
          toast.error(error instanceof Error ? error.message : "Couldn't start the AI review.");
        } finally {
          guard.release();
        }
      })();
    },
  };
}

/** Start work on a PR from the Reviews tab: create (or adopt) its worktree, go
 *  there, then launch.
 *
 *  `santreeRepo` must be **the project this PR belongs to** (`pr.project`), not
 *  whichever project the app happens to be pointed at: the inbox spans the whole
 *  registry now, so the two are routinely different and the worktree would be cut
 *  in the wrong checkout. The backend fails closed on the mismatch
 *  (`validate_pr_repo`), so the cost of getting it wrong is a refusal rather than
 *  a wrong branch — but a refusal is not an answer to a click either. */
export function useStartWorkFromReviews(
  pr: ReviewPr,
  santreeRepo: string,
  checkout: PrCheckout,
): StartWorkLauncher {
  const navigate = useNavigate();
  const { requestFixCiLaunch, abandonLaunchTab, addPendingLaunches, removePendingLaunch } =
    useAppUi();
  const guard = useLaunchGuard();
  // Silent, and quiet below: this flow reports its own failure and goes straight
  // to the tree it made, so neither half of the create needs a toast of its own.
  const { mutateAsync: createWorktree } = useCreateWorktree({ silent: true });
  const askForWorktree = useWorktreeGate();
  const { mutateAsync: promote } = usePromoteReviewWorktree(santreeRepo);
  const agentRuns = useOptionalAgentRuns();

  return {
    starting: guard.pending,
    start: () => {
      if (!guard.take()) return;
      // The one id a PR's checkout has, except when its branch names a ticket —
      // then the ticket's own id, so the sidebar bands the tree by that ticket's
      // project rather than leaving it with the unbanded work. What it must not
      // be is a third scheme: `pr-<n>` used to be one, and a PR could end up with
      // a differently-named tree depending on which button reached it first.
      const issueId = ticketIdFor(pr) ?? reviewTreeId(pr);
      // Set by the dialog's toggle, read once the worktree exists to run it in.
      let pendingSetup = false;
      void (async () => {
        // Nothing new reaches the disk when the PR is already checked out, so
        // there is nothing to confirm. A checkout still labelled a review is
        // promoted instead of asked about: it is about to become the tree you are
        // working in, and Trees — where this navigates — does not list reviews.
        if (!checkout.worktree) {
          if (checkout.source.isReview) {
            try {
              await promote({ prRepo: pr.repo, number: pr.number });
            } catch {
              guard.release();
              return;
            }
          } else {
            const choice = await askForWorktree("Starting work on this pull request");
            if (!choice.ok) {
              guard.release();
              return;
            }
            if (choice.runSetup) pendingSetup = true;
          }
        }
        // No project: a PR isn't one, and the placeholder is merged straight into
        // the sidebar's worktree list, where a stand-in would open a band of its
        // own.
        addPendingLaunches([
          { repo: santreeRepo, id: issueId, title: pr.title, project: null, agent: "Claude" },
        ]);
        navigate({ to: "/trees", search: { project: santreeRepo, tree: issueId } });
        // Unlike the two Trees paths, the tab cannot be opened at the click: there
        // is no worktree to hang it on yet. The sidebar's pending row covers that
        // stretch, and the tab goes up the moment the create resolves — still
        // ahead of the whole prompt render.
        let seed: TabSeed | null = null;
        try {
          const worktree = await createWorktree({
            repo: santreeRepo,
            issueId,
            title: pr.title,
            launch: { type: "pr", prRepo: pr.repo, branch: pr.headRef },
            base: null,
            agent: "Claude",
            quiet: true,
          });
          if (pendingSetup) agentRuns?.runSetup(santreeRepo, worktree.id);
          seed = {
            worktreeId: worktree.id,
            tabId: crypto.randomUUID(),
            kind: "fixCi",
            pr: tabPrFor(pr),
            title: TAB_TITLE,
            agentKind: "Claude",
          };
          requestFixCiLaunch({ ...seed, phase: "preparing" });
          const launch = await unwrap(commands.reviewFixLaunch(santreeRepo, reviewTargetFor(pr)));
          requestFixCiLaunch(readyLaunch(seed, launch));
        } catch (error) {
          // The placeholder only comes down on failure: on success the real
          // worktree replaces it, and clearing it here would flash the row away.
          if (seed) abandonLaunchTab(seed.tabId);
          removePendingLaunch(issueId);
          toast.error(error instanceof Error ? error.message : "Couldn't start the review fixes.");
        } finally {
          guard.release();
        }
      })();
    },
  };
}
