/**
 * The Setup tab's content: a worktree's `.santree/init.sh` output, streamed live
 * into the shared read-only {@link OutputPane} — the same pane the Dev tab's build
 * uses, so a colourful `init.sh` renders the way it does in a terminal.
 *
 * The run itself (the process, its transcript) is owned by `streamRuns` at module
 * scope, so it survives switching worktrees and navigating away from Trees entirely.
 */
import { useState } from "react";

import { OutputPane } from "../../components/OutputPane";
import { useCancelSetup } from "../../lib/queries";
import { markStopped, setupRunKey } from "../../state/streamRuns";

export function SetupLogsView({ repo, worktreeId }: { repo: string; worktreeId: string }) {
  const { mutate: cancelSetup } = useCancelSetup(repo);
  const [stopping, setStopping] = useState(false);

  return (
    <OutputPane
      runKey={setupRunKey(worktreeId)}
      label=".santree/init.sh"
      stopping={stopping}
      onStop={() => {
        setStopping(true);
        cancelSetup(worktreeId, {
          // The kill lands asynchronously; settle the pane now so the button
          // doesn't sit on "Stopping…" until the process notices.
          onSettled: () => {
            markStopped(setupRunKey(worktreeId));
            setStopping(false);
          },
        });
      }}
    />
  );
}
