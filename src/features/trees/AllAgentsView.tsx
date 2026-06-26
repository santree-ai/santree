/** Broadcast view: a grid of live agent terminals + one input to message all. */
import type { KeyboardEvent } from "react";

import type { Worktree } from "../../bindings";
import { branchFor } from "../../lib/format";
import { useWorktrees, useWorktreeTerminal } from "../../lib/queries";
import { toneColor } from "../../theme/colors";
import { useTrees } from "./model";

const RECENT_LINES = 10;

function AgentCard({ worktree }: { worktree: Worktree }) {
  const { termLog, sendTo } = useTrees();
  const { data: term } = useWorktreeTerminal(worktree.id);

  const running = worktree.activity === "Running";
  const statusColor = running ? "var(--accent)" : "#d29922";

  const seed = (term?.lines ?? []).map((l) => ({ text: l.text, color: toneColor(l.tone) }));
  const lines = [...seed, ...(termLog[worktree.id] ?? [])].slice(-RECENT_LINES);

  function onSend(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      sendTo(worktree.id, e.currentTarget.value);
      e.currentTarget.value = "";
    }
  }

  return (
    <div className="flex h-[228px] flex-col overflow-hidden rounded-[10px] border border-line-2 bg-deep">
      <div className="flex flex-none items-center gap-[7px] border-b border-line bg-well px-[11px] py-2">
        <span
          className="h-[7px] w-[7px] flex-none rounded-full"
          style={{ background: statusColor, boxShadow: `0 0 7px ${statusColor}` }}
        />
        <span className="flex-1 overflow-hidden font-mono text-[10.5px] text-ellipsis whitespace-nowrap text-fg-2">
          {branchFor(worktree.id)}
        </span>
        <span className="font-mono text-[9.5px]" style={{ color: statusColor }}>
          {worktree.activity.toLowerCase()}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.5]">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap" style={{ color: line.color }}>
            {line.text}
          </div>
        ))}
      </div>
      <div className="flex flex-none items-center gap-1.5 border-t border-line bg-panel px-2.5 py-[7px]">
        <span className="font-mono text-[11px]" style={{ color: statusColor }}>
          ›
        </span>
        <input
          type="text"
          onKeyDown={onSend}
          placeholder={`message ${worktree.id}…`}
          className="flex-1 border-none bg-transparent font-mono text-[11px] text-fg-3"
        />
      </div>
    </div>
  );
}

export function AllAgentsView() {
  const { data: worktrees = [] } = useWorktrees();
  const { broadcast } = useTrees();
  const agents = worktrees.filter((w) => w.activity === "Running" || w.activity === "Awaiting");

  function onBroadcast(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      broadcast(e.currentTarget.value);
      e.currentTarget.value = "";
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-3.5">
        {agents.map((w) => (
          <AgentCard key={w.id} worktree={w} />
        ))}
      </div>
      <div className="flex flex-none items-center gap-[11px] border-t border-line bg-panel px-4 py-[11px]">
        <span
          className="font-mono text-[11px] whitespace-nowrap"
          style={{ color: "var(--accent)" }}
        >
          ⇄ broadcast
        </span>
        <input
          type="text"
          onKeyDown={onBroadcast}
          placeholder={`Send one message to all ${agents.length} running agents — press ↵`}
          className="flex-1 rounded-lg border border-line-3 bg-input px-3 py-2.5 font-mono text-[12px] text-fg-3"
        />
      </div>
    </div>
  );
}
