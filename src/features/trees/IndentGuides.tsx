/** Per-depth indentation for a file-tree row: one vertical guide line per
 *  ancestor level so nesting reads clearly (a flat pixel pad didn't — folders
 *  and their contents looked like siblings). Shared by the Changes tree and the
 *  All-files browser so both indent identically.
 *
 *  Two rules the rows have to hold up their end of:
 *
 *  - **Height comes from `min-h`, never vertical padding.** `self-stretch` fills
 *    the flex line's cross size, which stops at the container's *content* box —
 *    so a row with `py-[3px]` cut a 3px gap out of every guide, top and bottom,
 *    and the columns rendered as stacks of dashes rather than as lines.
 *  - **No `gap` between the guides and what follows.** The line is drawn under
 *    its parent's disclosure arrow, so anything that shifts the row's content
 *    away from the guide column shifts the arrow off the line it belongs to.
 *
 *  The lines are drawn only while the pointer is over the tree ({@link TREE_GROUP}
 *  on the scroll container). A permanent ladder of rules is structure the reader
 *  is not asking about most of the time; it earns its ink at the moment they
 *  start tracing a row back to its folder. */
export const INDENT_PX = 16;

/** Half the disclosure arrow's slot — where the line has to sit for a folder's
 *  arrow to be directly above the guide its children hang from. */
const GUIDE_OFFSET = 7;

/** Height every guided row is laid out at, so the lines are unbroken from one
 *  row to the next. Matches the old `py-[3px]` + 16px line box exactly. */
export const ROW_MIN_H = "min-h-[22px]";

/** Put this on the scrolling container that holds guided rows: the guides fade
 *  in with it. Named (`/tree`) so a row's own `group` hover — the discard and
 *  staging actions — can't be confused with it. */
export const TREE_GROUP = "group/tree";

export function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span className="flex flex-none self-stretch" aria-hidden>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="relative" style={{ width: INDENT_PX }}>
          <span
            className="absolute inset-y-0 border-l border-line-2 opacity-0 transition-opacity group-hover/tree:opacity-100"
            style={{ left: GUIDE_OFFSET }}
          />
        </span>
      ))}
    </span>
  );
}
