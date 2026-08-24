import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";

import type { CheckLog, PrCheck, ReviewPr } from "../../bindings";
import { commands } from "../../bindings";
import { AgentIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import { queryKeys, unwrap } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { useAppUi } from "../../state/AppContext";
import { toast } from "../../state/toast";
import { ticketIdFor } from "./ticket";

/** Flatten a fetched CheckLog back into plain text for the AI fix prompt: loose
 *  lines verbatim, group sections as a title + indented body. */
function checkLogToText(log: CheckLog): string {
  return log.blocks
    .map((b) =>
      b.kind === "line" ? b.text : [b.title, ...b.lines.map((l) => `  ${l.text}`)].join("\n"),
    )
    .join("\n");
}

/** "Fix CI with AI": find-or-create the PR's worktree (checked out on its head
 *  branch), write a CI-fix prompt from the failing job logs, then hand off to the
 *  Trees tab which opens a Fix-CI Claude tab (commit/push denied — the user does
 *  that from Trees). Enabled only when there's a failed check with a fetchable
 *  Actions job log. */
export function FixCiButton({
  pr,
  santreeRepo,
  failed,
}: {
  pr: ReviewPr;
  santreeRepo: string;
  failed: PrCheck[];
}) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { requestFixCiLaunch, addPendingLaunches, removePendingLaunch } = useAppUi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The whole chain runs in the background after we navigate away, so nothing about
  // the button's own state can gate a second click: a ref is what actually holds
  // across the clicks of a double-click (a second run duplicates the pending launch,
  // the prompt render, and the Claude tab on the same worktree).
  const running = useRef(false);

  // Only failed checks whose Actions job log we can actually fetch are useful.
  const fixable = failed.filter((c) => c.jobId != null);
  if (fixable.length === 0) return null;

  // Land in Trees at once and reconcile in the background — the worktree create, a
  // log fetch per failing job, and the prompt render are seconds of round-trips, and
  // every other launch path in the app navigates first rather than holding the user
  // on a spinner. The Fix-CI tab opens itself once the prompt file exists (Trees
  // waits on `fixCiLaunch`); until then the sidebar shows the usual "Creating
  // workspace…" placeholder.
  function run() {
    if (running.current) return;
    running.current = true;

    const issueId = ticketIdFor(pr) ?? `pr-${pr.number}`;
    addPendingLaunches([{ id: issueId, title: pr.title, project: "Reviews", agent: "Codex" }]);
    navigate({ to: "/trees" });

    void (async () => {
      try {
        // Find-or-create a worktree on the PR's head branch (so the fix lands there).
        const worktree = await unwrap(
          commands.createWorktreeForPr(santreeRepo, issueId, pr.title, pr.headRef, null, "Codex"),
        );
        // Let the Trees list pick up the new worktree so its Fix-CI launch effect fires.
        await qc.invalidateQueries({ queryKey: queryKeys.worktrees(santreeRepo) });
        // Gather each failing job's log and label it by check name.
        const logs = await Promise.all(
          fixable.map(async (c) => {
            const log = await unwrap(commands.prCheckLog(owner, name, c.jobId));
            return `### ${c.name}\n\n${checkLogToText(log)}`;
          }),
        );
        const promptPath = await unwrap(
          commands.fixCiPrompt(santreeRepo, issueId, logs.join("\n\n")),
        );
        requestFixCiLaunch({ worktreeId: worktree.id, tabId: crypto.randomUUID(), promptPath });
      } catch (e) {
        running.current = false;
        removePendingLaunch(issueId);
        toast.error(e instanceof Error ? e.message : "Couldn't start the CI fix.");
      }
    })();
  }

  return (
    <Button size="sm" onClick={run} title="Fix the failing checks with Codex">
      <AgentIcon kind="Codex" size={11} />
      Fix CI with AI
    </Button>
  );
}
