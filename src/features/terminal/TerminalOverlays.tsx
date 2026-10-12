/** What a pane draws over its terminal when the session is not simply live:
 *  waiting on its host, or gone. Nothing here reads, probes or writes the PTY. */
import { useId } from "react";

import { PlayIcon, WarningIcon } from "../../components/icons";
import { Button } from "../../components/primitives";

/** A link that is down, and — once the host has kept the pane waiting too long —
 *  a word that terminals aren't answering, with where to look when the pane
 *  knows (`hint`). */
export function WaitingBadge({
  reconnecting,
  unanswered,
  hint,
}: {
  reconnecting: boolean;
  unanswered: boolean;
  hint?: string;
}) {
  if (!reconnecting && !unanswered) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-2 right-3 flex max-w-[280px] flex-col gap-0.5 rounded border border-line-2 bg-raised px-2 py-1 text-[11px] text-muted-2 shadow-sm"
    >
      {reconnecting && (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-amber" />
          Reconnecting…
        </span>
      )}
      {unanswered && (
        <span className="text-muted-3">Terminals aren't responding.{hint ? ` ${hint}` : ""}</span>
      )}
    </div>
  );
}

/** What a pane says when its session is gone but never ended. The terminal under
 *  it keeps its last output readable; nothing here starts, resumes or retries on
 *  its own — each action is a click. */
export function LostSession({
  onClose,
  onResume,
  resumeBlocked,
}: {
  onClose?: () => void;
  onResume?: () => void;
  resumeBlocked?: string;
}) {
  const hintId = useId();
  return (
    <div
      role="alert"
      className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border border-line-2 bg-raised px-3 py-2.5 shadow-sm"
    >
      <WarningIcon size={14} className="flex-none text-status-amber" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-fg-2">This terminal's session is gone</div>
        <div className="text-[11px] leading-[1.5] text-muted-3">
          santree lost it: the santree server stopped, or it never got a session. Nothing was
          restarted.
        </div>
        {onResume && resumeBlocked && (
          <div id={hintId} className="mt-0.5 text-[11px] leading-[1.5] text-muted-2">
            {resumeBlocked}
          </div>
        )}
      </div>
      {onResume && (
        <Button
          variant="primary"
          size="sm"
          onClick={onResume}
          disabled={!!resumeBlocked}
          aria-describedby={resumeBlocked ? hintId : undefined}
          aria-label="Resume this session"
        >
          <PlayIcon size={10} />
          Resume
        </Button>
      )}
      {onClose && (
        <Button size="sm" onClick={onClose} aria-label="Close this terminal">
          Close
        </Button>
      )}
    </div>
  );
}
