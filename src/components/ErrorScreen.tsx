/**
 * The friendly fallback shown when something throws. It never surfaces the raw
 * JavaScript error/stack to the user — just a calm message and clear actions
 * (retry, report, copy details for a bug report). Used by both the top-level
 * React error boundary and the router's default error component.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import { WarningIcon } from "./icons";
import { Button } from "./primitives";

const REPORT_URL = "https://github.com/santree-ai/santree/issues/new";

export function ErrorScreen({ error, onRetry }: { error?: Error; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  // Kept for the report/copy actions only — never rendered to the user.
  const details = [error?.message, error?.stack].filter(Boolean).join("\n\n") || "n/a";

  const report = () => {
    const title = encodeURIComponent(`Bug: ${error?.message ?? "Unexpected error"}`.slice(0, 120));
    const body = encodeURIComponent(
      `**What were you doing when this happened?**\n\n_(a sentence or two helps a lot)_\n\n` +
        `**Technical details**\n\n\`\`\`\n${details}\n\`\`\``,
    );
    openUrl(`${REPORT_URL}?title=${title}&body=${body}`);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — nothing more we can do
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-surface px-6 text-center">
      <div className="flex max-w-110 flex-col items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line-2 bg-panel">
          <WarningIcon size={26} className="text-status-amber" />
        </div>

        <div>
          <div className="text-[18px] font-semibold text-fg-bright">Something went wrong</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-2">
            santree hit an unexpected error. Try again, or go back to Agents — and if it keeps
            happening, please report it so we can fix it.
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {/* Retrying re-renders whatever just threw, so on its own it can strand
              you on a permanently broken view. "Back to Agents" is the way out:
              a hard load of the root route, which also rebuilds the module graph
              (the fix when the failure was a chunk that wouldn't import). */}
          <Button variant="primary" size="lg" onClick={() => window.location.assign("/")}>
            Back to Agents
          </Button>
          <Button size="lg" onClick={() => (onRetry ? onRetry() : window.location.reload())}>
            Try again
          </Button>
          <Button variant="ghost" size="lg" onClick={report}>
            Report issue
          </Button>
          <Button variant="ghost" size="lg" onClick={copy}>
            {copied ? "Copied ✓" : "Copy details"}
          </Button>
        </div>
      </div>
    </div>
  );
}
