/**
 * The "session ended — resume when ready" placeholder shown in place of a dead
 * terminal once its agent process has exited. Trees, Triage, and Reviews all use
 * it; the provider-aware backend decides whether Resume attaches a Claude
 * transcript, a Codex thread, or starts a replacement conversation.
 */
import type { ReactNode } from "react";

import { PlayIcon, TerminalIcon } from "./icons";
import { Button } from "./primitives";

export function SessionEndedPane({
  title,
  subtitle,
  onResume,
}: {
  title: string;
  subtitle: ReactNode;
  onResume: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <TerminalIcon size={20} className="text-muted-3" />
      <div>
        <div className="text-[13px] font-medium text-fg-2">{title}</div>
        <div className="mx-auto mt-1 max-w-[360px] text-[11.5px] leading-[1.6] text-muted-3">
          {subtitle}
        </div>
      </div>
      <Button variant="primary" onClick={onResume} className="mt-1">
        <PlayIcon size={11} />
        Resume
      </Button>
    </div>
  );
}
