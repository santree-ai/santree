/**
 * A ticket's properties, the way Linear's own page lists them — priority,
 * estimate, cycle, due date, project and milestone, assignee, labels — as a
 * row of small chips, each wearing the mark Linear gives that property.
 *
 * One component for every ticket surface: the Tickets rail (which draws it
 * from the list's own row, so it is there before the detail lands), the
 * worktree's Issue pane and the full page (which draw it from the detail).
 * The two sources are normalised into {@link IssueFacts} by the two helpers
 * below, so a property added to one is added to both. A chip is shown only
 * when the ticket has the property: a strip of "none"s says nothing.
 */
import type { ReactNode } from "react";
import type { CycleRef, Priority, Task, TriageDetail } from "../bindings";
import { PROJECT_FALLBACK } from "../theme/colors";
import { Avatar } from "./Avatar";
import { CycleIcon, EstimateIcon, MilestoneIcon } from "./icons";
import { ProjectGlyph } from "./primitives";
import {
  cycleProgress,
  formatPoints,
  IssueDueDate,
  MilestoneDueDate,
  PriorityBars,
} from "./WorkSignals";

export interface IssueFacts {
  priority: Priority;
  estimate: number | null;
  cycle: CycleRef | null;
  dueDate: string | null;
  project: string | null;
  projectColor: string | null;
  projectIcon: string | null;
  milestone: { name: string; targetDate: string | null } | null;
  assignee: string | null;
  assigneeAvatarUrl: string | null;
  /** `null` while unknown — the rail's row knows everything but the labels. */
  labels: string[] | null;
}

/** The backend's "No Project" placeholder is not a project. */
const projectName = (name: string | null | undefined) =>
  name && name !== "No Project" ? name : null;

export function factsOfDetail(detail: TriageDetail): IssueFacts {
  return {
    priority: detail.priority,
    estimate: detail.estimate,
    cycle: detail.cycle,
    dueDate: detail.dueDate,
    project: projectName(detail.project),
    projectColor: null,
    projectIcon: null,
    milestone: detail.projectMilestone
      ? { name: detail.projectMilestone.name, targetDate: detail.projectMilestone.targetDate }
      : null,
    assignee: detail.assignee,
    assigneeAvatarUrl: detail.assigneeAvatarUrl,
    labels: detail.labels,
  };
}

/** The list's row, with the detail's labels once it has landed. */
export function factsOfTask(task: Task, detail?: TriageDetail): IssueFacts {
  return {
    priority: task.priority,
    estimate: task.estimate,
    cycle: task.cycle,
    dueDate: task.dueDate,
    project: projectName(task.project),
    projectColor: task.projectColor,
    projectIcon: task.projectIcon,
    milestone: task.projectMilestone
      ? { name: task.projectMilestone.name, targetDate: task.projectMilestone.targetDate }
      : null,
    assignee: task.assignee,
    assigneeAvatarUrl: task.assigneeAvatarUrl,
    labels: detail?.labels ?? null,
  };
}

function Chip({ title, dense, children }: { title: string; dense: boolean; children: ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-flex flex-none items-center gap-1 rounded-md border border-line-2 bg-input whitespace-nowrap text-fg-3 ${
        dense ? "h-[18px] px-1.5 text-[10px]" : "h-5 px-2 text-[10.5px]"
      }`}
    >
      {children}
    </span>
  );
}

export function IssueProperties({
  facts,
  dense = false,
  withoutPriority = false,
  className = "",
}: {
  facts: IssueFacts;
  dense?: boolean;
  /** The host already shows the priority in its own header. */
  withoutPriority?: boolean;
  className?: string;
}) {
  const icon = dense ? 9 : 10;
  const cycleNumber =
    facts.cycle?.number == null
      ? "?"
      : Number.isInteger(facts.cycle.number)
        ? facts.cycle.number.toFixed(0)
        : String(facts.cycle.number);
  const chips: ReactNode[] = [];

  if (!withoutPriority && facts.priority !== "None") {
    chips.push(
      <Chip key="priority" title="Priority" dense={dense}>
        <PriorityBars priority={facts.priority} />
        {facts.priority}
      </Chip>,
    );
  }
  if (facts.estimate != null && facts.estimate > 0) {
    chips.push(
      <Chip key="estimate" title="Estimate" dense={dense}>
        <EstimateIcon size={icon} className="text-muted-3" />
        {formatPoints(facts.estimate)}
      </Chip>,
    );
  }
  if (facts.cycle) {
    chips.push(
      <Chip key="cycle" title="Cycle" dense={dense}>
        <CycleIcon size={icon + 1} progress={cycleProgress(facts.cycle)} className="text-muted-3" />
        {facts.cycle.name ?? `Cycle ${cycleNumber}`}
      </Chip>,
    );
  }
  if (facts.dueDate) {
    chips.push(
      <Chip key="due" title="Due date" dense={dense}>
        <IssueDueDate date={facts.dueDate} className="font-mono" />
      </Chip>,
    );
  }
  if (facts.project) {
    chips.push(
      <Chip key="project" title="Project" dense={dense}>
        <ProjectGlyph
          color={facts.projectColor ?? PROJECT_FALLBACK}
          icon={facts.projectIcon}
          size={6}
        />
        {facts.project}
      </Chip>,
    );
  }
  if (facts.milestone) {
    chips.push(
      <Chip key="milestone" title="Milestone" dense={dense}>
        <MilestoneIcon size={icon} className="text-muted-3" />
        {facts.milestone.name}
        <MilestoneDueDate date={facts.milestone.targetDate} />
      </Chip>,
    );
  }
  if (facts.assignee) {
    chips.push(
      <Chip key="assignee" title="Assignee" dense={dense}>
        <Avatar name={facts.assignee} src={facts.assigneeAvatarUrl} size={dense ? 11 : 12} />
        {facts.assignee}
      </Chip>,
    );
  }
  for (const label of facts.labels ?? []) {
    chips.push(
      <Chip key={`label-${label}`} title="Label" dense={dense}>
        <span className="font-mono">{label}</span>
      </Chip>,
    );
  }

  if (chips.length === 0) return null;
  return <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>{chips}</div>;
}
