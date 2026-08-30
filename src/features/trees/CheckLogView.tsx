/**
 * A CI check's raw job log, filling the main area.
 *
 * Opened by "View full details" on an expanded check in the PR pane. It lives
 * here rather than inside that pane because the pane is a ~300px column and a job
 * log is a wide, deep thing you scroll and search — the same reason a file's diff
 * opens here rather than in the file list that picked it.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

import { CloseIcon, GitHubLogo } from "../../components/icons";
import { EmptyState, TerminalActivity } from "../../components/primitives";
import { usePrCheckLog } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { CheckLogBody } from "../reviews/CheckLog";
import type { OpenCheckLog } from "./model";
import { useTrees } from "./model";

export function CheckLogView({ log }: { log: OpenCheckLog }) {
  const { closeCheckLog } = useTrees();
  const [owner, name] = splitRepoSlug(log.prRepo);
  const { data, isLoading } = usePrCheckLog(owner, name, log.jobId, true);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2" title={log.name}>
          {log.name}
        </span>
        <span className="flex-none font-mono text-[10px] text-muted-4">job #{log.jobId}</span>
        {log.url && (
          <button
            type="button"
            onClick={() => openUrl(log.url as string)}
            title="Open this run on GitHub"
            aria-label="Open this run on GitHub"
            className="flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
          >
            <GitHubLogo size={13} />
          </button>
        )}
        <button
          type="button"
          onClick={closeCheckLog}
          title="Close"
          aria-label="Close the check log"
          className="flex-none cursor-pointer text-muted-4 transition-colors hover:text-fg-2"
        >
          <CloseIcon size={11} />
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <TerminalActivity label="Loading log…" />
        </div>
      ) : !data ? (
        <EmptyState
          title="No log output"
          subtitle="GitHub didn't return a log for this run — it may have expired."
        />
      ) : (
        <div className="selectable min-h-0 flex-1">
          <CheckLogBody log={data} url={log.url} className="h-full" />
        </div>
      )}
    </div>
  );
}
