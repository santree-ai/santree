/**
 * The Setup tab's content: renders a worktree's `.santree/init.sh` output as
 * plain text. Purely presentational — the run itself (the streamed Channel and
 * accumulated `lines`) is owned by the Trees model, not this component, so
 * switching to another worktree and back doesn't unmount/remount the run (that
 * used to start a second concurrent `init.sh` in the same directory).
 */
import { useEffect, useRef } from "react";

export function SetupLogsView({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when lines grow.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-app px-3 py-2">
      <pre className="selectable font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-fg-3">
        {lines.map((line, i) => (
          // Lines only ever append or get replaced in place (progress redraws the
          // last one) — never reordered — so the index is a stable key. One node
          // per line avoids re-joining the whole buffer (O(n²)) on every event.
          <div key={i}>{line || " "}</div>
        ))}
      </pre>
    </div>
  );
}
