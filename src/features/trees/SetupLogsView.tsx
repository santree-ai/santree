/**
 * The Setup tab's content: runs a worktree's `.santree/init.sh` and shows its
 * output as plain text, streamed line-by-line over a Tauri Channel. No colours —
 * the basic, reliable view. When the script finishes it calls `onComplete`, which
 * closes the (temporary) Setup tab.
 *
 * IMPORTANT: the effect below kicks off a REAL `init.sh` run, and `startedRef`
 * only guards against re-fires within a single mount (refs reset on unmount). So
 * the parent (TreesView) MUST keep this component mounted while the Setup tab
 * exists and merely hide it when inactive — never `activeTab === "setup" && <…/>`.
 * Conditionally rendering it would unmount/remount on tab switches and start a
 * second setup run each time.
 */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

import { commands, type SetupEvent } from "../../bindings";

export function SetupLogsView({
  repo,
  worktreeId,
  onComplete,
}: {
  repo: string;
  worktreeId: string;
  /** Fired once when the script finishes (closes the Setup tab). */
  onComplete: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  // Whether the last appended line is a transient progress redraw — the next
  // `progress` event overwrites it in place; the next committed `line` commits
  // over it (so a finished progress bar collapses to its final frame).
  const lastWasProgress = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const channel = new Channel<SetupEvent>();
    channel.onmessage = (e) => {
      if (e.type === "progress") {
        setLines((prev) => {
          if (lastWasProgress.current && prev.length) {
            const next = prev.slice();
            next[next.length - 1] = e.text;
            return next;
          }
          return [...prev, e.text];
        });
        lastWasProgress.current = true;
      } else if (e.type === "line") {
        setLines((prev) => {
          if (lastWasProgress.current && prev.length) {
            const next = prev.slice();
            next[next.length - 1] = e.text;
            return next;
          }
          return [...prev, e.text];
        });
        lastWasProgress.current = false;
      } else {
        onCompleteRef.current();
      }
    };
    commands.runWorktreeSetupStreamed(repo, worktreeId, channel).then((r) => {
      if (r.status === "error") {
        setLines((prev) => [...prev, `Error: ${r.error}`]);
        onCompleteRef.current();
      }
    });
  }, [repo, worktreeId]);

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
          <div key={i}>{line || " "}</div>
        ))}
      </pre>
    </div>
  );
}
