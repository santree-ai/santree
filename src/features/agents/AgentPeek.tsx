/**
 * The peek panel: what the selected agent is asking, and the two things you can
 * do about it without leaving the panel — answer it, or go to it.
 *
 * The reply box types the user's own text into the live PTY, exactly as if they
 * had typed it in the terminal. That's the whole extent of it: nothing here
 * reads the agent's output or decides what to send (see COMPLIANCE.md). A
 * *permission* prompt deliberately has no reply box — answering one means
 * driving Claude's own menu, which is the user's to do in the real terminal.
 */
import { useState } from "react";
import type { WorktreePr } from "../../bindings";
import { PrChips } from "../../components/PrChip";
import { Button } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { WorktreeStats } from "../../components/WorktreeStats";
import { displayFill, fillColor } from "../../lib/contextFill";
import { formatUsd } from "../../lib/format";
import { useSessionUsageLive } from "../../lib/queries";
import { alpha, modelVersion, sessionStateMeta } from "../../theme/colors";
import { useTerminals } from "../terminal/TerminalsContext";
import { type AgentEntry, entryColor } from "./registry";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 flex-none font-mono text-[10px] text-muted-4">{label}</span>
      <span className="min-w-0 flex-1 text-[11.5px] text-muted-2">{children}</span>
    </div>
  );
}

export function AgentPeek({
  entry,
  prs,
  onOpen,
  onClose,
}: {
  entry: AgentEntry;
  prs: WorktreePr[];
  onOpen: () => void;
  onClose: () => void;
}) {
  const { send } = useTerminals();
  const { data: usage } = useSessionUsageLive();
  // Mounted keyed by session (see AgentsView), so a half-typed reply can never
  // carry from one agent onto another — no reset effect needed.
  const [reply, setReply] = useState("");
  const [sent, setSent] = useState(false);

  const meta = sessionStateMeta[entry.state];
  const color = entryColor(entry);
  const live = usage?.find((u) => u.sessionId === entry.sessionId);
  const pct = live ? displayFill(live.usedPct) : null;
  // Only a free-text question can be answered from here (see the file comment).
  const canReply = entry.live && entry.state === "waiting";

  const submit = () => {
    const text = reply.trim();
    if (!text || !entry.tabKey) return;
    if (!send(entry.tabKey, `${text}\r`)) return;
    setReply("");
    setSent(true);
  };

  return (
    <aside className="flex w-[340px] flex-none flex-col border-l border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-3 py-2.5">
        <span
          aria-hidden
          className="flex-none rounded-full"
          style={{ width: 7, height: 7, background: color }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">
          {entry.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="cursor-pointer rounded px-1 text-[13px] text-muted-4 hover:text-fg-2"
        >
          ×
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {entry.message && (
          <div
            className="rounded-lg border p-2.5 text-[12px] leading-[1.45] whitespace-pre-wrap text-fg-3"
            style={{ borderColor: alpha(35, color), background: alpha(8, color) }}
          >
            <div className="mb-1 font-mono text-[9.5px] tracking-wide" style={{ color }}>
              {meta?.label ?? entry.state}
            </div>
            {entry.message}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Field label="state">{meta?.label ?? entry.state}</Field>
          {entry.subtitle && <Field label="task">{entry.subtitle}</Field>}
          {entry.repo && <Field label="repo">{entry.repo}</Field>}
          {entry.worktree && <Field label="branch">{entry.worktree.branch}</Field>}
          <Field label="updated">
            <RelativeTime ms={entry.updatedAtMs} />
          </Field>
          {live && (
            <Field label="context">
              <span className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-muted-3">{modelVersion(live.model)}</span>
                <span className="h-1.5 w-16 flex-none overflow-hidden rounded-full bg-input">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${pct}%`, background: fillColor(pct ?? 0) }}
                  />
                </span>
                <span className="tabular-nums" style={{ color: fillColor(pct ?? 0) }}>
                  {pct}%
                </span>
                <span className="text-muted-4 tabular-nums">{formatUsd(live.costUsd)}</span>
              </span>
            </Field>
          )}
        </div>

        {(entry.worktree || prs.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-4">
            {entry.worktree && <WorktreeStats worktree={entry.worktree} showClean />}
            {prs.length > 0 && <PrChips prs={prs} />}
          </div>
        )}

        {canReply && (
          <div className="mt-auto flex flex-col gap-1.5">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder="Reply to this agent…"
              className="resize-none rounded-lg border border-line-2 bg-input px-2.5 py-2 text-[12px] text-fg-2 outline-none focus-visible:border-accent"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={submit} disabled={!reply.trim()}>
                Send
              </Button>
              <span className="text-[10px] text-muted-4">
                {sent ? "Sent to the session." : "⏎ to send · ⇧⏎ for a new line"}
              </span>
            </div>
          </div>
        )}
        {entry.state === "permission" && entry.live && (
          <p className="mt-auto text-[11px] leading-[1.5] text-muted-3">
            Permission prompts are answered in the session itself — santree never approves or denies
            on your behalf.
          </p>
        )}
      </div>

      <footer className="flex flex-none flex-col gap-1.5 border-t border-hairline p-2.5">
        <Button
          variant="primary"
          onClick={onOpen}
          disabled={!entry.openable}
          className="w-full justify-center"
        >
          {/* Always "open", never "resume": opening lands you on the owning
              surface, which offers its own resume affordance for a dead session.
              Promising a resume here would be promising something this doesn't do. */}
          Open session
        </Button>
        {!entry.openable && (
          <p className="text-center text-[10.5px] leading-[1.4] text-muted-4">
            santree didn't launch this session, so it can't tell which workspace it belongs to.
          </p>
        )}
      </footer>
    </aside>
  );
}
