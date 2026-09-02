/** One tab's agent: a persisted provider session rooted in the worktree.
 *
 *  Every agent is one of these — the one a started task launches, one opened from
 *  the "+" menu, one resumed from Session history, and the two PR-scoped review
 *  sessions. Its conversation is keyed by `tree:<worktree>:tab:<tab id>` in the
 *  session registry, so opening the tab — first ever, or after an app restart —
 *  resolves to a fresh `--session-id` launch or a `--resume` of the same
 *  conversation. When the process exits the tab closes with it (see
 *  {@link useTabSessions}), because a pane with nothing running has nothing to
 *  show; the conversation is still on disk, and Session history reopens it in a
 *  new tab.
 *
 *  Two variants differ from a plain one, and only in what they open with:
 *
 *  - the tab a **started task** minted seeds the ticket's *work prompt*, and holds
 *    its PTY until that prompt file (and any setup script before it) has landed —
 *    the seed only applies at session creation, so mounting early spawns a bare
 *    shell and silently drops the launch;
 *  - a **review** tab launches with the review deny list and santree's review MCP
 *    server, and opens by reading the prompt written when the Reviews button kicked
 *    it off. The prompt is seeded on the first (fresh) launch only; the capability
 *    paths apply to every launch, resume included — which is why they come from the
 *    persisted row (`useWorktreeTabLaunch`) once the in-memory hand-off is gone, and
 *    never from the plain no-git fallback.
 *
 *  It takes the two things only its host can answer as props — the hand-off, which
 *  is Trees' state, and the worktree's tabs, which decide the Remote Control claim
 *  — so the Reviews strip can host a checkout's agent tabs without a second copy
 *  of the launch pipeline. */
import type { Worktree, WorktreeTab } from "../../bindings";
import { EmptyState } from "../../components/primitives";
import { useWorktreeTabLaunch } from "../../lib/queries";
import { useAgentRuns } from "../../state/AgentRuns";
import type { FixCiLaunch } from "../../state/AppContext";
import { agentProvider } from "../terminal/agentProvider";
import { remoteControlTab } from "./model";
import { useAgentTab } from "./useAgentTab";
import { useWorkLaunch } from "./useWorkLaunch";
import { WorktreeTerminal } from "./WorktreeTerminal";

export function AgentTabPane({
  repo,
  worktree,
  tab,
  tabs,
  handoff,
}: {
  repo: string;
  worktree: Worktree;
  tab: WorktreeTab;
  /** The worktree's tabs — one of them claims the Remote Control name. */
  tabs: WorktreeTab[];
  /** The in-memory launch hand-off for a review tab opened this session, if the
   *  host has one. Absent after a restart (and in Reviews, which opens no review
   *  tabs of its own): the row is re-read instead. */
  handoff?: FixCiLaunch;
}) {
  const { clearAgentLaunch } = useAgentRuns();
  const review = tab.kind === "fixCi" || tab.kind === "aiReview";
  // The tab is opened at the click, so the first hand-off it gets is identity
  // only — the command that renders the prompt and writes the settings/MCP paths
  // is still running. That is *not* a launch: spawning against a missing MCP
  // config would hand the agent the standard tool grants and a stale diff index.
  // So it holds exactly as a restart does, and says which wait it is in.
  const rendering = handoff?.phase === "preparing" ? handoff : undefined;
  const ready = rendering ? undefined : handoff;
  const promptPath = ready?.promptPath;
  // Only after a restart (or a reload) is the hand-off missing; re-derive from the
  // row then, and hold the launch until it lands.
  const persisted = useWorktreeTabLaunch(repo, tab.id, review && !handoff);
  const launch = ready ?? persisted.data ?? undefined;
  const work = useWorkLaunch(repo, worktree, tab.id);

  const { preparing, seed, onExited, agent } = useAgentTab({
    repo,
    refId: `tree:${worktree.id}:tab:${tab.id}`,
    cwd: worktree.path,
    agent: tab.agentKind ?? "Claude",
    // An agent tab exists to run the agent, so any (re)open is an explicit launch.
    // The resolve still prefers resuming whatever this tab already has.
    allowFresh: true,
    // A review session without its own settings would run with the *standard* ones —
    // no deny list at all — so it waits instead. Resolving them is local work: a
    // settings write and a path derivation, no network.
    hold: (review && !launch) || work.hold,
    settingsPath: launch?.settingsPath,
    mcpConfigPath: launch?.mcpConfigPath ?? undefined,
    // A plain agent tab has no opening prompt (the user starts the conversation).
    // A review tab seeds the short "read the file" line — the rendered prompt carries
    // a whole PR diff, far past what can be typed into a shell — and a started task's
    // tab seeds the same shape for the ticket's work prompt.
    prompt: review
      ? promptPath
        ? `Read ${promptPath} and follow the instructions inside.`
        : "Continue the review of this branch. Do not commit or push."
      : work.prompt,
    // One tab per worktree claims its Remote Control name — see remoteControlTab.
    remoteControl: remoteControlTab(tabs) === tab.id ? worktree.id : undefined,
  });

  if (work.initialSetup) {
    return (
      <EmptyState
        className="h-full"
        title="Setting up the workspace…"
        subtitle="The terminal opens once setup finishes."
      />
    );
  }
  if (preparing) {
    // Say which wait this is, not "please wait". Each line is something the
    // frontend can actually observe — the render command still in flight, the
    // work prompt still being written, the session itself resolving — so the copy
    // can never claim progress the app hasn't seen. The terminal replaces this in
    // the same tab; there is no second place to look.
    const label = agentProvider(tab.agentKind ?? "Claude").label;
    const phase = rendering
      ? {
          title: `Reading pull request #${rendering.pr.number}…`,
          subtitle: `Rendering the prompt and ${label}'s review tools. The terminal opens here when they land.`,
        }
      : // No hand-off at all: this tab outlived the app that opened it, and its
        // settings and MCP paths are being re-derived from the persisted row.
        persisted.isLoading
        ? {
            title: "Restoring the review session…",
            subtitle: `Re-deriving ${label}'s review tools from the saved tab.`,
          }
        : {
            title: work.launching ? "Preparing the agent…" : `Starting ${label}…`,
            subtitle: review
              ? "The prompt is ready. The terminal opens here in a moment."
              : "The terminal opens in a moment.",
          };
    return <EmptyState className="h-full" title={phase.title} subtitle={phase.subtitle} />;
  }
  return (
    <WorktreeTerminal
      id={`${worktree.id}:tab:${tab.id}`}
      branch={tab.title}
      cwd={worktree.path}
      seed={seed}
      agent={agent}
      onLaunched={() => clearAgentLaunch(worktree.id)}
      onExited={onExited}
    />
  );
}
