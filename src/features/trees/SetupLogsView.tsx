/**
 * The Setup tab's content: a worktree's `.santree/init.sh` output as plain text,
 * plus a Stop button while it's running. The run itself (the streamed Channel and
 * the accumulated lines) is owned by `AgentRuns` at the app shell, so it survives
 * both switching worktrees and navigating away from Trees entirely.
 *
 * This is the *only* subscriber to the setup-lines context, deliberately: the lines
 * change once per output line, and a chatty `npm install` emits thousands.
 */
import { useEffect, useRef } from "react";

import { StopIcon } from "../../components/icons";
import { Button, Spinner } from "../../components/primitives";
import { useCancelSetup } from "../../lib/queries";
import { useSetupLines } from "../../state/AgentRuns";

// The Setup tab only exists while the script is running (it closes itself on Done),
// so this pane is always showing a live run — no finished state to render.
export function SetupLogsView({ repo, worktreeId }: { repo: string; worktreeId: string }) {
  const lines = useSetupLines(worktreeId);
  const { mutate: cancelSetup, isPending: stopping } = useCancelSetup(repo);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when lines grow.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[11.5px] text-muted-2">
          <Spinner size={11} />
          Running .santree/init.sh…
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="flex-none whitespace-nowrap"
          disabled={stopping}
          onClick={() => cancelSetup(worktreeId)}
        >
          <StopIcon size={10} />
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {/* One block element per line, so not a <pre> (which only takes phrasing
            content) — the classes reproduce its rendering. */}
        <div className="selectable font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-fg-3">
          {lines.map((line, i) => (
            // Lines only ever append or get replaced in place (progress redraws the
            // last one) — never reordered — so the index is a stable key. One node
            // per line avoids re-joining the whole buffer (O(n²)) on every event.
            <div key={i}>{line || " "}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
