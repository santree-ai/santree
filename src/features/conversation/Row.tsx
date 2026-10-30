/** The one row every step on the agent's side is drawn as (a tool call, a run of
 *  them, a thought, a note recorded as the user), so a long turn scans as a
 *  list: each icon in one 16px column on the prose's own edge, each line of
 *  words 24px in ({@link STEP_INDENT}), and whatever a row opens onto starting
 *  there too. The hover fill bleeds into the gutter rather than moving anything,
 *  and the chevron shows only on hover or once open: at rest a turn is words. */
import type { ReactNode } from "react";

import { ChevronRightIcon } from "../../components/icons";

/** Where a step's words start, and so where anything it opens onto starts. */
export const STEP_INDENT = "pl-6";

const SHAPE =
  "group -mx-2 flex min-w-0 gap-2 rounded-md px-2 py-[3px] text-left text-[12.5px] leading-[1.5]";

export function ActivityRow({
  icon,
  children,
  meta,
  trailing,
  open = false,
  onToggle,
  title,
  wrap = false,
}: {
  icon: ReactNode;
  /** The line itself: it truncates, the rest of the row doesn't. */
  children: ReactNode;
  /** Beside the line: a count, a diff stat, a state. */
  meta?: ReactNode;
  /** At the row's far end: a duration, in a column of its own. */
  trailing?: ReactNode;
  open?: boolean;
  /** Absent, the row is a line with nothing under it. */
  onToggle?: () => void;
  title?: string;
  /** Let the line wrap instead of truncating: a one-line note with nothing
   *  to open is read whole. */
  wrap?: boolean;
}) {
  const content = (
    <>
      <span className="flex h-[1.5em] w-4 flex-none items-center justify-center text-muted-4">
        {icon}
      </span>
      <span className={`min-w-0 ${wrap ? "break-words" : "truncate"}`}>{children}</span>
      {meta && (
        <span className="flex min-w-0 flex-none items-center gap-1.5 text-[11.5px] text-muted-4">
          {meta}
        </span>
      )}
      {onToggle && (
        <ChevronRightIcon
          size={10}
          className={`flex-none text-muted-4 transition-[transform,opacity] duration-150 ${
            open ? "rotate-90" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
        />
      )}
      {trailing && <span className="ml-auto flex flex-none items-center pl-3">{trailing}</span>}
    </>
  );
  if (!onToggle) {
    return (
      <div
        className={`${SHAPE} ${wrap ? "items-start" : "items-center"} text-muted-3`}
        title={title}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title={title}
      className={`${SHAPE} w-[calc(100%+1rem)] cursor-pointer items-center transition-colors hover:bg-hover hover:text-fg-2 ${
        open ? "text-fg-3" : "text-muted-2"
      }`}
    >
      {content}
    </button>
  );
}

/** A small heading inside an opened step: "Brief", "Report". */
export function StepLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[11px] font-medium text-muted-4">{children}</div>;
}
