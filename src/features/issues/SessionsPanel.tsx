/** Right-panel sessions list: live progress for launched agent runs. */

import type { CSSProperties } from "react";
import { useMemo } from "react";

import { Spinner } from "../../components/primitives";
import { branchFor, diffLabel } from "../../lib/format";
import { agentLabel, agentSlug } from "../../theme/colors";
import { type Session, useIssues, useStageHelpers } from "./model";

interface SessionVM {
  id: string;
  title: string;
  branch: string;
  agent: string;
  pct: number;
  color: string;
  done: boolean;
  stageLabel: string;
  metric: string;
  logLine: string;
  chained: boolean;
  base: string;
  cardStyle: CSSProperties;
}

function logFor(session: Session): string {
  switch (session.stage) {
    case 0:
      return "· queued";
    case 1:
      return `$ git worktree add ../${session.taskId.toLowerCase()} (from ${session.base || "main"})`;
    case 2:
      return `${agentSlug(session.agent)}: editing src/ … streaming`;
    case 3:
      return `running tests · ${Math.round(session.add / 30)} files changed`;
    default:
      return `✓ pushed · PR #${session.pr} ready`;
  }
}

export function SessionsPanel() {
  const { sessions, tasks } = useIssues();
  const { pctFor, labelFor } = useStageHelpers();
  const accent = "var(--accent)";

  const items = useMemo<SessionVM[]>(() => {
    const titleById = new Map(tasks.map((t) => [t.id, t.title]));
    return sessions.map((s) => {
      const done = s.stage >= 4;
      const color = done ? "#3fb950" : accent;
      return {
        id: s.taskId,
        title: titleById.get(s.taskId) ?? s.taskId,
        branch: branchFor(s.taskId),
        agent: agentLabel(s.agent),
        pct: pctFor(s.stage),
        color,
        done,
        stageLabel: s.stage === 2 ? `${agentSlug(s.agent)} working` : labelFor(s.stage),
        metric: done ? diffLabel(s.add, s.del) : `${pctFor(s.stage)}%`,
        logLine: logFor(s),
        chained: !!s.base && s.base !== "main",
        base: s.base,
        cardStyle: {
          border: `1px solid ${done ? "#2f6f4f" : "color-mix(in srgb, var(--accent) 27%, transparent)"}`,
          boxShadow: done
            ? "0 1px 2px rgba(0,0,0,.4)"
            : "0 8px 26px -12px color-mix(in srgb, var(--accent) 33%, transparent)",
        },
      };
    });
  }, [sessions, tasks, pctFor, labelFor]);

  if (items.length === 0) {
    return (
      <div className="px-[18px] py-10 text-center">
        <div className="mb-1.5 text-[13px] text-muted">No active sessions</div>
        <div className="text-[11.5px] leading-[1.5] text-muted-4">
          Select ready tasks and launch to spawn parallel terminal sessions.
        </div>
      </div>
    );
  }

  return (
    <div className="px-[13px] pt-3 pb-[18px]">
      {items.map((s) => (
        <div
          key={s.id}
          className="animate-fade-up mb-2.5 overflow-hidden rounded-[10px] bg-[#121316]"
          style={s.cardStyle}
        >
          <div className="flex items-center gap-1.5 border-b border-line bg-[#0e0f12] px-2.5 py-[7px]">
            <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
            <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
            <span className="h-2 w-2 rounded-full bg-[#28c840]" />
            <span className="ml-1 flex-1 overflow-hidden font-mono text-[10.5px] text-ellipsis whitespace-nowrap text-muted-2">
              {s.branch}
            </span>
            <span className="font-mono text-[9.5px]" style={{ color: s.color }}>
              {s.agent}
            </span>
          </div>
          <div className="px-[11px] py-2.5">
            <div className="mb-[9px] flex items-center gap-2">
              <span className="flex-none font-mono text-[10px] text-muted-2">{s.id}</span>
              <span className="overflow-hidden text-[12px] text-ellipsis whitespace-nowrap text-fg-3">
                {s.title}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded-sm bg-line-2">
              <div
                className="h-full transition-[width] duration-500"
                style={{ width: `${s.pct}%`, background: s.color, boxShadow: `0 0 8px ${s.color}` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span
                className="flex items-center gap-1.5 font-mono text-[10.5px]"
                style={{ color: s.color }}
              >
                {s.done ? <span>✓</span> : <Spinner size={9} color={s.color} />}
                {s.stageLabel}
              </span>
              <span className="font-mono text-[10px] text-muted-4">{s.metric}</span>
            </div>
            <div className="mt-2 overflow-hidden rounded-[5px] bg-panel px-[7px] py-[5px] font-mono text-[10px] text-ellipsis whitespace-nowrap text-[#55555d]">
              {s.logLine}
            </div>
            {s.chained && (
              <div className="mt-[5px] font-mono text-[9.5px]" style={{ color: accent }}>
                ⛓ stacked on {s.base}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
