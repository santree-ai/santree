/** One of a triage ticket's own agent tabs: a plain provider session on the
 *  attached project's main checkout, to ask things in beside the investigation.
 *
 *  A `worktree_tabs` row hanging off the ticket's surface, so it launches
 *  through the same pipeline a worktree's agent tab does (`useAgentTab`) — its
 *  conversation keyed by `triage:<ticket>:tab:<id>`, resumed on the next open,
 *  first ever or after a restart — on the `triage` surface: the Investigate
 *  settings, and the read-only Codex sandbox the backend derives from the same
 *  prefix. No opening prompt: the user starts the conversation. When the
 *  process exits the tab closes with it (`useTabSessions`, from the strip),
 *  because a pane with nothing running has nothing to show. A pane whose
 *  session is *lost* resumes in place instead, on the click (`useLostTabResume`). */
import type { WorktreeTab } from "../../bindings";
import { EmptyState } from "../../components/primitives";
import { ConversationFace } from "../conversation/ConversationFace";
import { useConversationFace } from "../conversation/viewMode";
import { agentProvider } from "../terminal/agentProvider";
import { useAgentTab } from "../trees/useAgentTab";
import { ResumingState, useLostTabResume } from "../trees/useLostTabResume";
import { tabRefId } from "../trees/useTabSessions";
import { triageTermKey } from "./providerSessions";
import { TriageTerminal } from "./TriageTerminal";

export function TriageTabPane({
  repo,
  ticketId,
  cwd,
  tab,
}: {
  /** The ticket's attached project — what the row and its session are stored under. */
  repo: string;
  ticketId: string;
  /** The project's root — the main checkout. */
  cwd: string;
  tab: WorktreeTab;
}) {
  const owner = triageTermKey(ticketId);
  const refId = tabRefId(owner, tab.id);
  const agentKind = tab.agentKind ?? "Claude";
  const { preparing, ended, seed, onExited, agent, resume } = useAgentTab({
    repo,
    surface: "triage",
    refId,
    cwd,
    agent: agentKind,
    // An agent tab exists to run the agent, so any (re)open is an explicit launch.
    allowFresh: true,
  });
  const { onResume, resuming } = useLostTabResume({
    repo,
    owner,
    tabId: tab.id,
    refId,
    ended,
    resume,
  });
  const conversation = useConversationFace(refId, agent?.kind, repo);

  if (resuming) return <ResumingState />;
  if (preparing) {
    return (
      <EmptyState
        className="h-full"
        title={`Starting ${agentProvider(agentKind).label}…`}
        subtitle="The terminal opens in a moment."
      />
    );
  }
  return (
    <ConversationFace
      face={conversation}
      live={{ repo, termKey: refId }}
      onResume={agent ? onResume : undefined}
    >
      {/* Kept mounted with the conversation up, holding no slot: see AgentTabPane. */}
      <TriageTerminal
        refId={refId}
        title={tab.title}
        cwd={cwd}
        seed={seed}
        agent={agent}
        attach={!conversation.shown}
        onExited={onExited}
        onResume={agent ? onResume : undefined}
      />
    </ConversationFace>
  );
}
