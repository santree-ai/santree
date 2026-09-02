/**
 * The rail's queue pane: what will launch, one card per ticket, and the one
 * button that launches it.
 *
 * A card is the ticket at a glance — key, state, priority, the branch it will
 * stack on — plus the two things worth deciding per ticket before it runs: which
 * agent, and the notes the agent is handed as context (the same notes the
 * ticket pane keeps; `custom_context` in the Work prompt). The model is not one
 * of them: it comes from Settings for the chosen agent, and the card says which
 * so there is no guessing (see the model's note on why there is no second
 * source). Clicking the ticket itself opens it in the ticket pane and leaves it
 * queued — reading a ticket is not a decision about it.
 */
import { useMemo } from "react";

import type { AgentKind, Task } from "../../bindings";
import { CloseIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { Button, ChevronSelect, EmptyState } from "../../components/primitives";
import {
  CycleTag,
  EstimateTag,
  IssueDueDate,
  PriorityBars,
  StatusGlyph,
} from "../../components/WorkSignals";
import { agentAvailable } from "../../lib/format";
import {
  useAgents,
  useResolvedProviderSetting,
  WORK_AGENT_KEY,
  WORK_MODEL_KEY,
} from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { statusLabel } from "../../theme/colors";
import { useIssues } from "./model";
import { TaskNotes } from "./TaskNotes";

interface AgentOption {
  key: AgentKind;
  label: string;
}

export function QueuePane() {
  const {
    selectedEligible,
    clearSelection,
    launch,
    baseFor,
    launchAgent,
    agentFor,
    setQueueAgent,
    toggle,
    setFocus,
    setRailTab,
  } = useIssues();
  const { activeRepo } = useApp();
  const { data: agents = [] } = useAgents();
  // Only providers whose runtime adapter is registered.
  const options = useMemo<AgentOption[]>(
    () => agents.filter((a) => agentAvailable(a)).map((a) => ({ key: a.key, label: a.label })),
    [agents],
  );

  const count = selectedEligible.length;
  if (count === 0) {
    return (
      <EmptyState
        title="Nothing queued"
        subtitle="Select Ready in the header, or the mark before a ticket in the list, adds it here. Each queued ticket launches in a worktree of its own."
      />
    );
  }
  const chained = selectedEligible.filter((t) => !t.ready).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-1.5 border-b border-hairline px-4 py-2">
        <span className="font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">Queue</span>
        <span className="font-mono text-[10px] text-muted-3">{count}</span>
        <button
          type="button"
          onClick={clearSelection}
          className="ml-auto cursor-pointer text-[10.5px] text-muted-4 hover:text-muted"
        >
          clear
        </button>
      </div>

      <div className="min-w-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {selectedEligible.map((task) => (
          <QueueCard
            key={task.id}
            task={task}
            repo={activeRepo}
            agent={agentFor(task.id)}
            options={options}
            chainBase={baseFor(task)}
            onOpen={() => {
              setFocus(task.id);
              setRailTab("issue");
            }}
            onRemove={() => toggle(task.id)}
            // Picking the configured agent is not an override — it is the
            // default again, so the pick is dropped rather than stored.
            onAgent={(agent) => setQueueAgent(task.id, agent === launchAgent ? null : agent)}
          />
        ))}
      </div>

      <div className="flex-none border-t border-line bg-well px-4 pt-3 pb-3.5">
        {chained > 0 && (
          <div className="mb-2.5 font-mono text-[10px]" style={{ color: "var(--accent)" }}>
            ⛓ {chained} will stack on a running worktree
          </div>
        )}
        <Button variant="primary" size="lg" onClick={launch} className="w-full">
          <span className="text-[10px]">▶</span>
          <span>
            Launch {count} {count === 1 ? "agent" : "agents"}
          </span>
        </Button>
      </div>
    </div>
  );
}

function QueueCard({
  task,
  repo,
  agent,
  options,
  chainBase,
  onOpen,
  onRemove,
  onAgent,
}: {
  task: Task;
  repo: string;
  agent: AgentKind;
  options: AgentOption[];
  chainBase: string | null;
  onOpen: () => void;
  onRemove: () => void;
  onAgent: (agent: AgentKind) => void;
}) {
  // What this card's agent will run with — resolved for *this* agent, so a
  // Codex card never shows Claude's model.
  const { data: model } = useResolvedProviderSetting(repo, WORK_MODEL_KEY, agent, WORK_AGENT_KEY);

  return (
    <div className="rounded-lg border border-line-2 bg-input">
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <button
          type="button"
          onClick={onOpen}
          title="Open in the ticket pane — it stays queued"
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-left"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-2">{task.id}</span>
            <span className="flex items-center gap-1.5 text-[10.5px] text-muted-3">
              <StatusGlyph status={task.status} size={11} />
              {statusLabel[task.status]}
            </span>
            <PriorityBars priority={task.priority} />
            {task.estimate != null && task.estimate > 0 && <EstimateTag estimate={task.estimate} />}
            {task.cycle && <CycleTag cycle={task.cycle} />}
            <IssueDueDate date={task.dueDate} />
          </span>
          <MarkdownTitle className="block text-[12.5px] leading-[1.35] text-fg-2">
            {task.title}
          </MarkdownTitle>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${task.id} from the queue`}
          title="Remove from the queue"
          className="-mt-0.5 -mr-1 flex flex-none cursor-pointer items-center rounded p-1 text-muted-4 hover:bg-hover hover:text-fg-2"
        >
          <CloseIcon size={11} />
        </button>
      </div>
      {chainBase && (
        <div className="px-3 pt-1.5 font-mono text-[10.5px] text-muted-3">
          ⛓ branches off {chainBase}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pt-2">
        <span className="font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">Agent</span>
        <ChevronSelect
          value={agent}
          onChange={(v) => onAgent(v as AgentKind)}
          aria-label={`Agent for ${task.id}`}
          className="h-6 rounded-md border border-line-2 bg-raised pr-7 pl-2 font-mono text-[11px] text-fg-2"
          wrapperClassName="flex-none"
        >
          {options.map((a) => (
            <option key={a.key} value={a.key} className="bg-input">
              {a.label}
            </option>
          ))}
        </ChevronSelect>
        <span
          className="min-w-0 truncate font-mono text-[10px] text-muted-3"
          title="Configured in Settings → Actions → Work"
        >
          {model || "default model"}
          <span className="text-muted-4"> (Settings)</span>
        </span>
      </div>
      <TaskNotes key={task.id} repo={repo} taskId={task.id} embedded />
    </div>
  );
}
