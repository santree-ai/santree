/**
 * The "session ended — resume when ready" placeholder shown in place of a dead
 * terminal once its agent process has exited: the Trees main work terminal, a
 * Trees Claude tab, and the Triage investigation all use it. Resume re-seeds the
 * terminal, which the backend resolves to a `claude --resume <id>` against the
 * on-disk transcript (or a fresh session if the transcript is gone).
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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
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
