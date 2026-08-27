/**
 * One live agent, nested under the worktree it runs in.
 *
 * The row's only job is to answer "does this want me, and what is it saying" in
 * a single 22px line. So the text is the *pending question* whenever there is
 * one — the only line in the tree that ever requires a decision — and falls back
 * to what the session is doing otherwise. It is deliberately plain text rather
 * than rendered markdown: a fenced span or an inline `code` pill would blow the
 * row's height, and at this size the characters are the content.
 */
import type { AgentEntry } from "../../features/agents/registry";
import { sessionStateMeta } from "../../theme/colors";
import { AgentIcon } from "../icons";
import { RelativeTime } from "../RelativeTime";
import { AttentionDot } from "./AttentionDot";
import type { AgentNode } from "./useProjectTree";

/** What the row says: the ask, else the state, else the provider's name. */
function textOf(entry: AgentEntry): string {
  return entry.message ?? sessionStateMeta[entry.state]?.label ?? entry.purpose;
}

/** One agent row. `indent` is the left gutter its nesting level has earned. */
export function AgentRow({
  node,
  indent,
  onOpen,
}: {
  node: AgentNode;
  indent: number;
  onOpen: () => void;
}) {
  const { entry, attention, unseen } = node;
  const text = textOf(entry);
  // Brighter for something new, and for anything blocked — looking at a question
  // does not answer it, so an unanswered ask never dims down with age.
  const emphasized = unseen || attention.level === "needs-you";

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!entry.openable}
      title={`${entry.purpose} · ${text}`}
      className="selection-row flex min-h-[22px] w-full cursor-pointer items-center gap-1.5 py-px pr-2 text-left disabled:cursor-default disabled:opacity-60"
      style={{ paddingLeft: indent }}
    >
      <AttentionDot level={attention.level} />
      <AgentIcon kind={entry.agentKind} size={10} className="flex-none text-muted-4" />
      <span
        className={`min-w-0 flex-1 truncate text-[11px] leading-[1.4] ${
          emphasized ? "font-medium text-fg-2" : "text-muted-3"
        }`}
      >
        {text}
      </span>
      <RelativeTime
        ms={entry.updatedAtMs}
        className="flex-none font-mono text-[10px] text-muted-4 tabular-nums"
      />
    </button>
  );
}
