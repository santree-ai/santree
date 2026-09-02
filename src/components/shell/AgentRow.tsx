/**
 * One live agent, inside the worktree card it runs in.
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

/** What the row says: the ask, else the state, else what the session is for.
 *
 *  The last fallback is load-bearing rather than defensive: an agent santree has
 *  launched whose provider hasn't reported in yet has no state to name, and the
 *  row says what it is ("Worktree tab") instead of inventing a status. */
function textOf(entry: AgentEntry): string {
  const state = entry.state ? sessionStateMeta[entry.state]?.label : undefined;
  return entry.message ?? state ?? entry.purpose;
}

/** One agent row. `indent` is where the row's own content begins — the worktree
 *  title's **text** column, the same rule every other child row in this tree
 *  follows (a row hangs from its heading's label, not from its glyph). The dot
 *  and the provider mark lead, so the label lands one cluster further in and the
 *  line reads as something *inside* the card rather than a sibling of it. */
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
      className="tree-row flex min-h-6 w-full cursor-pointer items-center gap-1.5 py-0.5 pr-1.5 text-left disabled:cursor-default disabled:opacity-60"
      style={{ paddingLeft: indent }}
    >
      {/* One cluster: the state and who is in that state belong together, and the
          row's own gap is what separates them from the label. Not *tight*,
          though — a 2px gap read as one crowded glyph rather than two marks, and
          the dot is the one thing on this row a reader scans for. */}
      <span className="flex flex-none items-center gap-1.5">
        <AttentionDot level={attention.level} size={6} />
        {/* A fixed slot, so a session santree can't attribute to a provider
            leaves the label's column intact instead of shifting it left. */}
        <span className="flex size-2.5 flex-none items-center justify-center">
          {entry.agentKind && (
            <AgentIcon kind={entry.agentKind} size={10} className="text-muted-4" />
          )}
        </span>
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[11px] leading-4 ${
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
