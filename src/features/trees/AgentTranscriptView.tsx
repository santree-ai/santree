/**
 * MOCK transcript view — a static seed transcript + a local echo input.
 *
 * This is NOT the real PTY terminal (see terminal/TerminalView.tsx). It renders
 * the backend's canned transcript lines plus any locally-appended mock log. When
 * the real terminal embed lands, swap this component for that stack.
 */
import type { KeyboardEvent } from "react";

import { Spinner } from "../../components/primitives";
import { useWorktrees, useWorktreeTerminal } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { toneColor } from "../../theme/colors";
import { useTrees } from "./model";

export function AgentTranscriptView() {
  const { activeId, termLog, sendTo } = useTrees();
  const { activeRepo } = useApp();
  const { data: term } = useWorktreeTerminal(activeId);
  const { data: worktrees = [] } = useWorktrees();

  const worktree = worktrees.find((w) => w.id === activeId);
  const inputEnabled = worktree?.activity === "Running" || worktree?.activity === "Awaiting";
  // TODO: derive the repo folder from the worktree itself once the Worktree type
  // carries a path/repo; activeRepo is the only readily-available source today.
  const repoFolder = activeRepo.split("/")[1] ?? "repo";
  const extra = termLog[activeId] ?? [];

  function onSend(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      sendTo(activeId, e.currentTarget.value);
      e.currentTarget.value = "";
    }
  }

  if (!term) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b border-hairline px-3.5 py-2">
        <span className="font-mono text-[11px] text-muted-2">
          ~/{repoFolder}/{term.cwd}
        </span>
        <span
          className="flex items-center gap-[7px] font-mono text-[10.5px]"
          style={{ color: toneColor(term.statusTone) }}
        >
          {term.running && <Spinner size={9} color={toneColor(term.statusTone)} />}
          {term.status}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-[1.65]">
        {term.lines.map((line, i) => (
          <div
            key={`seed-${i}`}
            className="whitespace-pre-wrap"
            style={{ color: toneColor(line.tone), paddingLeft: line.indent }}
          >
            {line.text}
          </div>
        ))}
        {extra.map((line, i) => (
          <div key={`log-${i}`} className="whitespace-pre-wrap" style={{ color: line.color }}>
            {line.text}
          </div>
        ))}

        {term.running && (
          <div
            className="animate-blink mt-[3px] inline-block h-[15px] w-2 align-text-bottom"
            style={{ background: "var(--accent)" }}
          />
        )}

        {inputEnabled && (
          <div className="mt-3 flex items-center gap-[7px] rounded-lg border border-line-3 bg-input px-[11px] py-2.5">
            <span style={{ color: "var(--accent)" }}>›</span>
            <input
              type="text"
              onKeyDown={onSend}
              placeholder="send a message to this agent — press ↵"
              className="flex-1 border-none bg-transparent font-mono text-[12px] text-fg-3"
            />
          </div>
        )}
      </div>
    </div>
  );
}
