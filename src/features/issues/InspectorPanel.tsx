/** Right-panel inspector: details for the focused ticket. */
import { useMemo } from "react";

import { Dot } from "../../components/primitives";
import { branchFor, diffLabel } from "../../lib/format";
import { statusColor, statusLabel } from "../../theme/colors";
import { useIssues } from "./model";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-mono text-[10px] tracking-[.08em] text-muted-3 uppercase">
      {children}
    </div>
  );
}

interface RefRow {
  id: string;
  title: string;
  project: string;
  foreign: boolean;
}

export function InspectorPanel() {
  const { tasks, focusId, sessionByTask, baseFor } = useIssues();

  const focus = tasks.find((t) => t.id === focusId) ?? tasks[0];

  const { session, done, ready, chainBase, blocked, blockedBy, blocks } = useMemo(() => {
    if (!focus) {
      return {
        session: undefined,
        done: false,
        ready: false,
        chainBase: null,
        blocked: false,
        blockedBy: [] as RefRow[],
        blocks: [] as RefRow[],
      };
    }
    const s = sessionByTask.get(focus.id);
    const cb = focus.ready ? null : baseFor(focus);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return {
      session: s,
      done: !!s && s.stage >= 4,
      ready: focus.ready,
      chainBase: cb,
      blocked: !focus.ready && cb === null,
      blockedBy: focus.blockedBy.map<RefRow>((id) => {
        const t = byId.get(id);
        return {
          id,
          title: t?.title ?? "",
          project: t?.project ?? "",
          foreign: !!t && t.project !== focus.project,
        };
      }),
      blocks: tasks
        .filter((t) => t.blockedBy.includes(focus.id))
        .map<RefRow>((t) => ({ id: t.id, title: t.title, project: t.project, foreign: false })),
    };
  }, [focus, tasks, sessionByTask, baseFor]);

  if (!focus) return null;

  return (
    <div className="px-4 pt-4 pb-5">
      <div className="mb-[5px] font-mono text-[11px] text-muted-2">{focus.id}</div>
      <div className="mb-3 text-[16px] leading-[1.3] font-semibold text-fg-bright">
        {focus.title}
      </div>

      <div className="mb-[18px] flex items-center gap-3.5">
        <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
          <Dot color={statusColor[focus.status]} size={8} />
          {statusLabel[focus.status]}
        </span>
        {ready && (
          <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-status-green">
            <Dot color="#3fb950" size={6} />
            ready to start
          </span>
        )}
        {chainBase && (
          <span
            className="flex items-center gap-1 font-mono text-[11.5px]"
            style={{ color: "var(--accent)" }}
          >
            ⛓ stack on {branchFor(chainBase)}
          </span>
        )}
        {blocked && <span className="font-mono text-[11.5px] text-muted-3">⊘ blocked</span>}
      </div>

      <div className="mb-3.5 border-t border-line pt-3.5">
        <SectionLabel>⎇ Worktree</SectionLabel>
        {session ? (
          <div className="font-mono text-[12px] text-[color:var(--color-branch)]">
            {branchFor(focus.id)}
          </div>
        ) : (
          <div className="font-mono text-[12px] text-muted-4">no worktree for this ticket</div>
        )}
      </div>

      <div className="mb-3.5 border-t border-line pt-3.5">
        <SectionLabel>◉ Pull Request</SectionLabel>
        {done && session ? (
          <div>
            <div className="font-mono text-[12px] text-[color:var(--color-branch)]">
              PR #{session.pr} · open
            </div>
            <div className="mt-[3px] font-mono text-[11px] text-muted-4">
              {diffLabel(session.add, session.del)} across files
            </div>
          </div>
        ) : (
          <div className="font-mono text-[12px] text-muted-4">no PR yet</div>
        )}
      </div>

      {blockedBy.length > 0 && (
        <div className="mb-3.5 border-t border-line pt-3.5">
          <SectionLabel>Blocked by</SectionLabel>
          {blockedBy.map((b) => (
            <div
              key={b.id}
              className="mb-[5px] flex items-center gap-2 rounded-md border border-line-2 bg-input px-[9px] py-[7px]"
            >
              <span className="flex-none font-mono text-[10.5px] text-status-amber">{b.id}</span>
              <span className="flex-1 overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap text-muted">
                {b.title}
              </span>
              {b.foreign && (
                <span className="flex-none overflow-hidden rounded text-ellipsis whitespace-nowrap border border-cross/40 bg-cross/[0.08] px-[5px] py-px font-mono text-[8.5px] text-cross">
                  ↗ {b.project}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {blocks.length > 0 && (
        <div className="border-t border-line pt-3.5">
          <SectionLabel>Blocks</SectionLabel>
          {blocks.map((b) => (
            <div
              key={b.id}
              className="mb-[5px] flex items-center gap-2 rounded-md border border-line-2 bg-input px-[9px] py-[7px]"
            >
              <span className="flex-none font-mono text-[10.5px] text-muted-2">{b.id}</span>
              <span className="overflow-hidden text-[11.5px] text-ellipsis whitespace-nowrap text-muted">
                {b.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
