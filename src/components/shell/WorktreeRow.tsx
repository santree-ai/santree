/**
 * One worktree, and the agents running in it, as a single card.
 *
 * The card is the selectable thing, not the line inside it: what you pick in
 * this tree is "this piece of work", and its agents are part of that, so the
 * highlight covers them too. Inside, an agent row can still take its own hover —
 * they composite, so a hovered agent reads on a selected card.
 *
 * **Line one is identity.** The title, the branch glyph that marks the repo's own
 * checkout, and at the trailing edge the marks of what this work is linked to
 * (its Linear ticket, its GitHub PR). The marks moved up here from the branch
 * line because that is what they describe — the *work*, not the ref it happens
 * to live on.
 *
 * **The branch name is gone from the row.** It is the longest string in the tree
 * and the least often read: it repeats the title in kebab-case, and a sidebar
 * this narrow truncates both. It lives on the row's tooltip and in the
 * right-click menu (Copy branch), beside the other place-on-disk facts.
 *
 * **Line two is the agents**, and only when there are any. One agent renders its
 * own row — shorter and more informative than any summary of it. Several
 * collapse into {@link AgentSummaryRow}, which expands in place.
 *
 * Nothing about the diff: how much has changed, and whether it is committed,
 * belongs to the Changes pane beside the lists that say it. The card carries no
 * status dot of its own either — state belongs to the agents underneath it,
 * which each wear theirs.
 *
 * The card's own action is a stretched button rather than a wrapper, because the
 * PR mark is a real button and ARIA makes a button's children presentational —
 * nested inside one the mark would vanish from the accessibility tree. The marks
 * stay positioned so they paint, and hit-test, above the stretched action.
 */
import { useState } from "react";

import { MAX_DEPTH } from "../../features/trees/worktreeGrouping";
import type { TreeFocusPane } from "../../state/AppContext";
import { BranchIcon, LinearLogo } from "../icons";
import { MarkdownTitle } from "../Markdown";
import { PrMark } from "../PrChip";
import { Spinner } from "../primitives";
import { AgentRow } from "./AgentRow";
import { AgentSummaryRow } from "./AgentSummaryRow";
import type { AgentNode, WorktreeNode } from "./useProjectTree";
import { WorktreeMenu } from "./WorktreeMenu";

/** Width of one nesting level. Small on purpose: the tree is three levels deep
 *  before a stacked branch adds any, and a wider step starves the text column in
 *  a sidebar that is only a few hundred pixels across. */
export const INDENT_PX = 14;

/** How far the card overhangs its own row's text. The highlight starts one inset
 *  before the title rather than at the rail's edge, so it reads as an object you
 *  picked and not as a band across the window — a card under a milestone heading
 *  stays inside its group instead of stretching left past it. The text pays the
 *  inset back as padding, so its gutter is absolute and nothing shifts when the
 *  card lights up. */
const CARD_INSET = 6;

/** What the branch glyph on a `primary` row means. Deliberately not "the default
 *  branch": the flag marks the repo's own checkout, which sits on whatever branch
 *  you last left it on — the row shows that branch, and claiming it is `main`
 *  would be a claim the data does not make. */
const PRIMARY_LABEL = "The repo's own checkout";

/** Shared chrome for the trailing marks. They sit above the card's stretched
 *  action (see the file comment), so they need their own hit area and hover. */
const MARK_CLASS =
  "relative flex cursor-pointer items-center rounded p-0.5 text-muted-4 transition-colors hover:bg-hover-2 hover:text-fg-2";

/** One worktree card. `indent` is the gutter its own level earns before the
 *  stacked-branch depth is added. */
export function WorktreeRow({
  repo,
  node,
  indent,
  selected,
  onSelect,
  onOpenPane,
  onOpenAgent,
}: {
  repo: string;
  node: WorktreeNode;
  indent: number;
  /** This is the worktree the workspace view has open. */
  selected: boolean;
  onSelect: () => void;
  /** Open this worktree with a given right-panel pane showing — what the Linear
   *  and GitHub marks do. */
  onOpenPane: (pane: TreeFocusPane) => void;
  onOpenAgent: (agent: AgentNode) => void;
}) {
  const { worktree: w, prs, task, agents } = node;
  // Local, not persisted: expanding is a "let me look" gesture, and a tree that
  // reopens yesterday's expansions on launch is noisier than one that doesn't.
  const [expanded, setExpanded] = useState(false);
  const rowIndent = indent + Math.min(node.depth, MAX_DEPTH) * INDENT_PX;
  // The card begins one inset before its own row's text; everything inside it
  // pays that inset back, so the gutter stays absolute at `rowIndent`.
  const cardIndent = rowIndent - CARD_INSET;
  const linked = task !== null || prs.length > 0;
  // The stretched action covers everything unpositioned inside the card, so a
  // tooltip on the branch glyph itself would never open — what the mark means
  // rides on the row's own tooltip instead, beside the branch it is marking.
  const rowTitle = [w.title || w.id, w.branch, node.primary ? PRIMARY_LABEL : null]
    .filter(Boolean)
    .join("\n");

  const card = (
    <div
      className="tree-card relative"
      data-active={selected}
      style={{ marginLeft: cardIndent, marginRight: CARD_INSET }}
    >
      <div
        className="relative flex items-center gap-1.5 py-(--density-standard) pr-1.5"
        style={{ paddingLeft: CARD_INSET }}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Open ${w.title || w.id}`}
          // The branch is still one hover away — it just no longer costs a line.
          title={w.pending ? undefined : rowTitle}
          className="absolute inset-0 cursor-pointer"
        />
        {w.pending ? (
          // Nothing on disk yet, so there is no branch, no PR and no agent to
          // show — say what is happening instead of rendering blanks.
          <>
            <Spinner size={9} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-3">
              Creating {w.title || w.id}…
            </span>
          </>
        ) : (
          <>
            <MarkdownTitle
              className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${
                selected ? "font-medium text-fg" : "font-medium text-fg-2"
              }`}
            >
              {w.title || w.id}
            </MarkdownTitle>
            {/* Not a claim about the default branch: this is the repo's own
                checkout, sitting on whatever branch it happens to have — which
                is why the mark is a branch glyph in the row's own ink and not a
                tinted "primary" label the data can't back up. */}
            {node.primary && (
              <span
                role="img"
                aria-label={PRIMARY_LABEL}
                className="flex flex-none items-center text-fg-2"
              >
                <BranchIcon size={12} />
              </span>
            )}
            {linked && (
              <span className="relative flex flex-none items-center gap-0.5">
                {task && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPane("issue");
                    }}
                    title={`Linear · ${task.id} — open the ticket`}
                    aria-label={`Open the Linear ticket for ${w.title || w.id}`}
                    className={MARK_CLASS}
                  >
                    <LinearLogo size={11} />
                  </button>
                )}
                {/* Both marks open the same panel, on their own pane: the mark
                    says what this worktree is linked to, so pressing it should
                    show that thing — not leave the app for github.com. */}
                <PrMark prs={prs} onOpen={() => onOpenPane("pr")} className={MARK_CLASS} />
              </span>
            )}
          </>
        )}
      </div>

      {agents.length === 1 && (
        <AgentRow node={agents[0]} indent={CARD_INSET} onOpen={() => onOpenAgent(agents[0])} />
      )}
      {agents.length > 1 && (
        <AgentSummaryRow
          agents={agents}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
          indent={CARD_INSET}
        />
      )}
      {agents.length > 1 &&
        expanded &&
        agents.map((agent) => (
          <AgentRow
            key={agent.entry.sessionId}
            node={agent}
            indent={CARD_INSET + INDENT_PX}
            onOpen={() => onOpenAgent(agent)}
          />
        ))}
      {/* The card's own bottom padding, so the last agent row isn't flush with
          the highlight's edge. Zero when there is nothing under the title. */}
      {agents.length > 0 && <div className="h-1" />}
    </div>
  );

  // A worktree that is still being created has no path on disk yet, so none of
  // the menu's actions can point anywhere — it gets the plain card.
  return w.pending ? (
    card
  ) : (
    <WorktreeMenu repo={repo} worktree={w} primary={node.primary}>
      {card}
    </WorktreeMenu>
  );
}
