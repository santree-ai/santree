/**
 * One worktree, and the agents running in it.
 *
 * Two lines, fixed: what the work is, then where it lives (branch, diff size, the
 * PR it produced). The dot is the aggregate of everything nested underneath, so
 * a collapsed-looking row still tells you whether something inside it is asking
 * for you.
 *
 * The row's own action is a stretched button rather than a wrapper, because the
 * PR chip is a real button and ARIA makes a button's children presentational —
 * nested inside one the chip would vanish from the accessibility tree. The chips
 * stay positioned so they paint, and hit-test, above the stretched action.
 */
import { MarkdownTitle } from "../Markdown";
import { PrChips } from "../PrChip";
import { Pill, Spinner } from "../primitives";
import { WorktreeStats } from "../WorktreeStats";
import { AgentRow } from "./AgentRow";
import { AttentionDot } from "./AttentionDot";
import type { AgentNode, WorktreeNode } from "./useProjectTree";

/** Width of one nesting level. Small on purpose: the tree is three levels deep
 *  before a stacked branch adds any, and a wider step starves the text column in
 *  a sidebar that is only a few hundred pixels across. */
export const INDENT_PX = 14;

/** Deepest level that still steps in. A longer chain keeps its order but stops
 *  indenting, so a tall stack can't squeeze the rows at the bottom of it. */
const MAX_DEPTH = 3;

/** One worktree row plus its agent rows. `indent` is the gutter its own level
 *  earns before the stacked-branch depth is added. */
export function WorktreeRow({
  node,
  indent,
  onSelect,
  onOpenAgent,
}: {
  node: WorktreeNode;
  indent: number;
  onSelect: () => void;
  onOpenAgent: (agent: AgentNode) => void;
}) {
  const { worktree: w, prs, agents } = node;
  const rowIndent = indent + Math.min(node.depth, MAX_DEPTH) * INDENT_PX;

  return (
    <div>
      <div
        className="selection-row relative flex items-start gap-1.5 py-[3px] pr-2"
        style={{ paddingLeft: rowIndent }}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Open ${w.title || w.id}`}
          className="absolute inset-0 cursor-pointer"
        />
        <span className="mt-[5px] flex">
          <AttentionDot level={node.attention.level} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <MarkdownTitle
              className="min-w-0 flex-1 truncate text-[13px] leading-[1.35] font-medium text-fg-2"
              title={w.title || w.id}
            >
              {w.title || w.id}
            </MarkdownTitle>
            {node.primary && (
              <Pill
                color="var(--accent)"
                className="px-1 py-px font-mono text-[10px] font-semibold tracking-wide"
                title="The repo's default branch"
              >
                primary
              </Pill>
            )}
          </div>
          <div className="mt-px flex min-w-0 items-center gap-x-1.5 font-mono text-[11px] leading-[1.4] text-muted-4">
            {w.pending ? (
              // Nothing on disk yet, so there is no branch, no diff and no PR to
              // show — say what is happening instead of rendering three blanks.
              <>
                <Spinner size={9} />
                Creating workspace…
              </>
            ) : (
              <>
                <span className="min-w-0 truncate">{w.branch}</span>
                <WorktreeStats worktree={w} />
                {prs.length > 0 && (
                  <span className="relative ml-auto flex flex-none items-center">
                    <PrChips prs={prs} />
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {agents.map((agent) => (
        <AgentRow
          key={agent.entry.sessionId}
          node={agent}
          indent={rowIndent + INDENT_PX}
          onOpen={() => onOpenAgent(agent)}
        />
      ))}
    </div>
  );
}
