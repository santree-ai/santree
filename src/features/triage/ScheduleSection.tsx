/** The on-call schedule strips at the top of the triage sidebar. */
import { useState } from "react";

import type { TriageSchedule } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ChevronDownIcon } from "../../components/icons";
import { Badge } from "../../components/primitives";
import { useApp } from "../../state/AppContext";

/** All of the viewer's triage on-call rotations (one per team). */
export function ScheduleSection({ schedules }: { schedules: TriageSchedule[] }) {
  if (schedules.length === 0) return null;
  return (
    <div className="flex-none space-y-1.5 border-b border-hairline px-[13px] py-2.5">
      {schedules.map((s) => (
        <ScheduleStrip key={`${s.team}-${s.scheduleName}`} schedule={s} />
      ))}
    </div>
  );
}

function ScheduleStrip({ schedule }: { schedule: TriageSchedule }) {
  const [open, setOpen] = useState(false);
  const { accent } = useApp();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-line-2 bg-input px-2.5 py-2 text-left transition-colors hover:border-line-strong"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[9px] tracking-[.06em] text-muted-4 uppercase">
            {schedule.scheduleName}
          </div>
          <div className="mt-[5px] flex items-center gap-1.5">
            <Avatar name={schedule.currentName ?? "—"} src={schedule.currentAvatarUrl} size={18} />
            <span className="truncate text-[12px] font-medium text-fg-2">
              {schedule.currentName ?? "—"}
            </span>
          </div>
        </div>
        {schedule.currentIsMe && <Badge color={accent}>YOU</Badge>}
        <span
          className="flex-none text-muted-3 transition-transform duration-150"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          <ChevronDownIcon size={13} />
        </span>
      </button>

      {open && (
        <div className="mt-1.5 rounded-lg border border-line-2 bg-input p-1.5">
          {(schedule.shifts ?? []).map((s) => (
            <div
              key={`${s.name}-${s.range}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5"
              style={
                s.isCurrent
                  ? { background: "color-mix(in srgb, var(--accent) 8%, transparent)" }
                  : undefined
              }
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
