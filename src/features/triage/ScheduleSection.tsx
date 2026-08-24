/** The on-call schedule strips at the top of the triage sidebar. */
import { useState } from "react";

import type { TriageSchedule } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ChevronDownIcon } from "../../components/icons";
import { Badge } from "../../components/primitives";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";

/** All of the viewer's triage on-call rotations (one per team). */
export function ScheduleSection({ schedules }: { schedules: TriageSchedule[] }) {
  if (schedules.length === 0) return null;
  return (
    <div className="flex-none space-y-2 border-b border-hairline px-3 py-3">
      {schedules.map((s) => (
        <ScheduleStrip key={`${s.team}-${s.scheduleName}`} schedule={s} />
      ))}
    </div>
  );
}

function ScheduleStrip({ schedule }: { schedule: TriageSchedule }) {
  const [open, setOpen] = useState(false);
  const { accent } = useApp();
  const scheduleLabel =
    schedule.scheduleName.replace(schedule.team, "").trim() || schedule.scheduleName;

  return (
    <div className="relative entity-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span className="text-[16px]" aria-hidden>
          🌱
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11.5px] font-medium text-fg-2">{schedule.team}</span>
            <span className="truncate font-mono text-[9px] text-muted-4">{scheduleLabel}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            {schedule.currentName ? (
              <Avatar name={schedule.currentName} src={schedule.currentAvatarUrl} size={19} />
            ) : (
              <span className="flex h-[19px] w-[19px] items-center justify-center rounded-full border border-line-strong bg-input font-mono text-[9px] text-muted-4">
                ?
              </span>
            )}
            <span className="truncate text-[11px] text-muted-2">
              {schedule.currentName ?? "No active coverage"}
            </span>
            {schedule.currentIsMe ? (
              <Badge color={accent}>You are covering</Badge>
            ) : schedule.currentName ? (
              <span className="font-mono text-[9px] text-status-green">covered</span>
            ) : (
              <span className="font-mono text-[9px] text-status-red">uncovered</span>
            )}
          </div>
        </div>
        <span
          className="flex-none text-muted-3 transition-transform duration-150"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          <ChevronDownIcon size={13} />
        </span>
      </button>

      {open && (
        <div className="border-t border-line bg-input/40 p-1.5">
          {(schedule.shifts ?? []).map((s) => (
            <div
              key={`${s.name}-${s.range}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              style={s.isCurrent ? { background: alpha(8) } : undefined}
            >
              <Avatar name={s.name} src={s.avatarUrl} size={20} />
              <span
                className="min-w-0 flex-1 truncate text-[11.5px]"
                style={{ color: s.isMe ? "var(--accent-text)" : "var(--color-fg-2)" }}
              >
                {s.name}
                {s.isMe && !s.isCurrent && " (you)"}
              </span>
              <span className="flex-none whitespace-nowrap font-mono text-[10px] text-muted-4">
                {s.range}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
