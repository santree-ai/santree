/** Compact, reusable signals for work/review rows. They answer three different
 * scanning questions without adding label-heavy pills: urgency, effort, and a
 * project's delivery horizon. */
import type { Priority } from "../bindings";
import { priorityColor, prSizeColor } from "../theme/colors";

export type ChangeSize = "XS" | "S" | "M" | "L" | "XL";

const SIZE_LEVEL: Record<ChangeSize, number> = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };
const SIZE_LABEL: Record<ChangeSize, string> = {
  XS: "Very small",
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "Very large",
};

export function changeSizeOf(additions: number, deletions: number, files: number): ChangeSize {
  const score = additions + deletions + files * 20;
  if (score < 50) return "XS";
  if (score < 200) return "S";
  if (score < 600) return "M";
  if (score < 1500) return "L";
  return "XL";
}

export function ChangeSizeBars({
  additions,
  deletions,
  files,
  noun = "change",
}: {
  additions: number;
  deletions: number;
  files: number;
  noun?: string;
}) {
  const size = changeSizeOf(additions, deletions, files);
  const level = SIZE_LEVEL[size];
  const color = prSizeColor[size];
  const detail = `${SIZE_LABEL[size]} ${noun}: ${files} file${files === 1 ? "" : "s"}, +${additions} −${deletions}`;
  return (
    <span role="img" aria-label={detail} title={detail} className="flex h-2 items-center gap-[2px]">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className="h-[4px] w-[3px] rounded-[1px]"
          style={{ background: index < level ? color : "var(--color-line-3)" }}
        />
      ))}
    </span>
  );
}

const PRIORITY_LEVEL: Record<Exclude<Priority, "None">, number> = {
  Low: 1,
  Medium: 2,
  High: 3,
  Urgent: 4,
};

export function PriorityBars({ priority }: { priority: Exclude<Priority, "None"> }) {
  const level = PRIORITY_LEVEL[priority];
  const color = priorityColor[priority];
  return (
    <span
      role="img"
      aria-label={`${priority} priority`}
      title={`${priority} priority`}
      className="flex h-2.5 items-end gap-px"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <span
          key={index}
          className="w-[2px] rounded-[1px]"
          style={{
            height: 3 + index * 1.5,
            background: index < level ? color : "var(--color-line-3)",
          }}
        />
      ))}
    </span>
  );
}

/** A project's target date belongs beside the project heading, not repeated on
 * every task. Near and overdue dates gain urgency; distant dates stay quiet. */
export function ProjectDueDate({ date }: { date: string | null | undefined }) {
  if (!date) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((parsed.getTime() - today.getTime()) / 86_400_000);
  const label = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(parsed);
  const color =
    days < 0
      ? "var(--color-status-red)"
      : days <= 14
        ? "var(--color-status-amber)"
        : "var(--color-muted-4)";

  return (
    <span
      className="ml-auto flex-none font-mono text-[9px] normal-case tracking-normal"
      style={{ color }}
      title={`Project target date: ${parsed.toLocaleDateString()}`}
    >
      {days < 0 ? "overdue" : "due"} {label}
    </span>
  );
}
