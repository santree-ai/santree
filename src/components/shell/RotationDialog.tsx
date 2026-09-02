/**
 * A triage rotation's whole schedule, as a small dialog.
 *
 * The sidebar's rotation row says who has it now and until when; this is the
 * rest — every shift in order, the current one washed, yours marked. It used
 * to fold open in place under the row, which put seven avatars and seven date
 * ranges in a rail whose other rows are tickets. A schedule is reference you
 * look up now and then, so it opens over the app and closes on Escape, the
 * overlay or the corner ×, the way the project picker does.
 */
import { useId, useRef } from "react";
import { createPortal } from "react-dom";

import type { TriageSchedule, TriageShift } from "../../bindings";
import { formatShiftRange, formatShiftTimes } from "../../lib/relativeTime";
import { alpha } from "../../theme/colors";
import { Avatar } from "../Avatar";
import { CloseIcon } from "../icons";
import { useModalA11y } from "../primitives";

const rangeOf = (shift: TriageShift) => formatShiftRange(shift.startsAtMs, shift.endsAtMs);

export function RotationDialog({
  schedule,
  onClose,
}: {
  schedule: TriageSchedule;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useModalA11y({ open: true, onClose, dialogRef, initialFocusRef: closeRef });

  const current = schedule.shifts.find((shift) => shift.isCurrent);
  const title = schedule.currentIsMe
    ? "You are on triage"
    : schedule.currentName
      ? `${schedule.currentName} is on triage`
      : "Nobody is on triage";

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        className="relative flex w-[380px] max-w-full flex-col rounded-xl border border-line-3 bg-panel shadow-2xl"
        style={{ animation: "toastIn .16s ease-out" }}
      >
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          {schedule.currentName ? (
            <Avatar name={schedule.currentName} src={schedule.currentAvatarUrl} size={32} />
          ) : (
            <span
              aria-hidden
              className="flex size-8 flex-none items-center justify-center rounded-full border border-line-strong font-mono text-[12px] text-muted-4"
            >
              ?
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[13px] font-semibold text-fg-bright">
              {title}
            </h2>
            <div className="mt-0.5 truncate text-[11.5px] text-muted-3">
              {schedule.scheduleName}
              {current && <span className="font-mono"> · {rangeOf(current)}</span>}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2"
          >
            <CloseIcon size={12} />
          </button>
        </div>

        {/* Reference, not a list of destinations: the current shift takes a
            wash rather than the selection fill, which would promise a click. */}
        <ul aria-label="Shifts" className="flex flex-col gap-0.5 border-t border-line p-2">
          {schedule.shifts.map((shift) => (
            <li
              key={`${shift.name}-${shift.startsAtMs}`}
              className="flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5"
              style={{ background: shift.isCurrent ? alpha(8) : undefined }}
            >
              <Avatar name={shift.name} src={shift.avatarUrl} size={18} />
              <span
                className="min-w-0 flex-1 truncate text-[12px]"
                style={{ color: shift.isMe ? "var(--accent-text)" : "var(--color-fg-2)" }}
              >
                {shift.name}
                {shift.isMe && " (you)"}
              </span>
              {shift.isCurrent && <span className="tree-tag">now</span>}
              {/* Days in the row; the tooltip says when in the day it changes hands. */}
              <span
                className="flex-none font-mono text-[10.5px] whitespace-nowrap text-muted-3"
                title={formatShiftTimes(shift.startsAtMs, shift.endsAtMs)}
              >
                {rangeOf(shift)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
