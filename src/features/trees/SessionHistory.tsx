/** The History pane: every agent session that has run in this worktree, newest
 *  first — what it was asked, what it last said, who ran it and how long ago.
 *  A session still running here is marked live and opens its tab on click; a
 *  finished one is a record. */
import type { WorktreeSession } from "../../bindings";
import { AgentIcon, RefreshIcon } from "../../components/icons";
import { EmptyState, ListSkeleton } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { useWorktreeSessions } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { agentBrandColor, sessionStateMeta } from "../../theme/colors";
import type { AgentEntry } from "../agents/registry";
import { useAgentEntries } from "../agents/useAgents";
import { useOpenAgent } from "../agents/useOpenAgent";
import { useTrees } from "./model";

/** A model id as a badge: the vendor prefix says nothing next to the agent icon. */
function modelLabel(model: string): string {
  return model.replace(/^claude-/, "");
}

export function SessionHistory() {
  const { repo, activeId } = useTrees();
  const { activeRepo } = useApp();
  const { data: sessions, refetch, isFetching } = useWorktreeSessions(repo, activeId);
  const entries = useAgentEntries([activeRepo], [activeRepo]);
  const openAgent = useOpenAgent();
  const liveById = new Map((entries ?? []).map((e) => [e.sessionId, e]));

  return (
    <>
      <div className="flex flex-none items-start justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-fg">Session history</div>
          {/* No count until the read lands: "0 sessions" beside a skeleton is a claim. */}
          <div className="text-[11px] text-muted-4">
            {sessions === undefined
              ? "\u00a0"
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          aria-busy={isFetching}
          aria-label="Refresh session history"
          title="Refresh"
          className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
        >
          <RefreshIcon size={12} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      {sessions === undefined ? (
        <ListSkeleton rows={4} className="p-2" />
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          subtitle="Every agent that runs in this worktree shows up here."
        />
      ) : (
        <SessionList sessions={sessions} liveById={liveById} openAgent={openAgent} />
      )}
    </>
  );
}

function SessionList({
  sessions,
  liveById,
  openAgent,
}: {
  sessions: WorktreeSession[];
  liveById: Map<string, AgentEntry>;
  openAgent: (entry: AgentEntry) => void;
}) {
  return (
    <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
      {sessions.map((s) => {
        const live = liveById.get(s.sessionId);
        const openable = !!live?.openable;
        return (
          <button
            key={s.sessionId}
            type="button"
            disabled={!openable}
            onClick={() => live && openAgent(live)}
            title={openable ? "Open this session" : undefined}
            className="selection-row flex w-full cursor-pointer flex-col gap-1 px-3 py-3 text-left disabled:cursor-default"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-2">
                {s.title ?? "Untitled session"}
              </span>
              {live && (
                <span
                  className="flex-none rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    background: sessionStateMeta[live.state]?.color,
                  }}
                  title={sessionStateMeta[live.state]?.label}
                />
              )}
            </span>
            {s.lastMessage && (
              <span className="line-clamp-2 text-[11px] leading-[1.4] text-muted-3">
                {/* Who said it, because the latest line can be your own unanswered
                    prompt — the one case where the session is waiting on nobody. */}
                {s.lastMessageFrom && (
                  <span className="font-medium text-fg-2">
                    {s.lastMessageFrom === "You" ? "You" : "Agent"}:{" "}
                  </span>
                )}
                {s.lastMessage}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-4">
              <span className="flex flex-none" style={{ color: agentBrandColor(s.agentKind) }}>
                <AgentIcon kind={s.agentKind} size={11} />
              </span>
              <span className="tabular-nums">{s.messageCount} msgs</span>
              {s.subagentCount > 0 && (
                <span className="tabular-nums">
                  · {s.subagentCount} subagent{s.subagentCount === 1 ? "" : "s"}
                </span>
              )}
              <span>·</span>
              <RelativeTime ms={s.lastActivityMs} />
              {s.model && (
                <span className="ml-auto min-w-0 truncate" title={s.model}>
                  {modelLabel(s.model)}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
