/**
 * The "Commits" tab: what the pull request actually proposes to merge, oldest
 * first — the order the commits will land in.
 *
 * A PR's commits are the reviewer's second reading of it. The diff says what
 * changed; the commit list says in what steps, and a message body is where an
 * author explains a decision the code can't. So a row expands to its body rather
 * than hiding it behind a trip to github.com, and the short OID is copyable
 * because the next thing you do with a suspicious commit is `git show` it.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { PrCommit, ReviewPr } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { ChevronDownIcon, CommitIcon, CopyIcon, WarningIcon } from "../../components/icons";
import { EmptyState, Skeleton } from "../../components/primitives";
import { RelativeTime } from "../../components/RelativeTime";
import { usePrDetail } from "../../lib/queries";
import { isoMs } from "../../lib/relativeTime";
import { splitRepoSlug } from "../../lib/repo";
import { toast } from "../../state/toast";
import { palette } from "../../theme/colors";
import { PR_COLUMN } from "./prLayout";

export function PrCommitsPane({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail, isLoading } = usePrDetail(owner, name, pr.number);
  const commits = detail?.commits ?? [];

  return (
    <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className={PR_COLUMN}>
        {isLoading ? (
          // Rows, not a sentence: "loading" told in the shape of what is coming
          // reads as the list arriving, where a line of prose reads as the answer.
          <ListSkeleton />
        ) : commits.length === 0 ? (
          <EmptyState
            className="py-10"
            icon={<CommitIcon size={20} className="text-muted-4" />}
            title="This pull request has no commits."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line-2">
            {commits.map((commit) => (
              <CommitRow key={commit.oid} commit={commit} />
            ))}
          </div>
        )}
        {/* The list is capped at one page. Say so — for the same reason the file
            list does: a reviewer who believes they read every commit and did not
            has drawn a conclusion from a history that wasn't all there. */}
        {detail?.commitsTruncated && (
          <div
            className="mt-2 flex items-center gap-1.5 text-[11px]"
            style={{ color: palette.amber }}
          >
            <WarningIcon size={11} />
            Showing the first {commits.length} commits. This PR has more.
          </div>
        )}
      </div>
    </div>
  );
}

function CommitRow({ commit }: { commit: PrCommit }) {
  const [expanded, setExpanded] = useState(false);
  const body = commit.messageBody.trim();

  return (
    <div className="border-b border-line-2 last:border-b-0">
      <div className="flex items-start gap-2 px-3 py-2">
        <Avatar name={commit.author} src={commit.authorAvatarUrl} size={20} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <button
              type="button"
              onClick={() => openUrl(commit.url)}
              title={`Open ${commit.abbreviatedOid} on GitHub`}
              className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12px] text-fg-2 hover:text-fg-bright hover:underline"
            >
              {commit.messageHeadline}
            </button>
            {body && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the message of ${commit.abbreviatedOid}`}
                title={expanded ? "Hide the commit message" : "Show the full commit message"}
                className="flex-none cursor-pointer rounded border border-line-2 bg-input px-1 text-muted-3 hover:border-line-strong hover:text-fg-2"
              >
                <ChevronDownIcon
                  size={11}
                  className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
                />
              </button>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-4">
            <span className="truncate">{commit.author}</span>
            <span aria-hidden>·</span>
            <RelativeTime ms={isoMs(commit.committedDate)} className="font-mono" />
          </div>
        </div>
        {/* The full OID, not the abbreviation on the button: what you paste into
            `git show` has to be unambiguous outside GitHub's own repo view. */}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(commit.oid);
            toast.success("Commit copied.");
          }}
          title={`Copy ${commit.oid}`}
          className="group flex flex-none cursor-pointer items-center gap-1.5 rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[10.5px] text-muted-2 hover:border-line-strong"
        >
          {commit.abbreviatedOid}
          <CopyIcon size={10} className="text-muted-3 group-hover:text-fg-2" />
        </button>
      </div>
      {expanded && body && (
        <pre className="border-t border-hairline px-3 py-2 pl-[46px] font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-muted-2">
          {body}
        </pre>
      )}
    </div>
  );
}

/** Three commit-shaped rows while the read is in flight. Widths vary so the
 *  block reads as a list of messages rather than as a loaded table. */
function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line-2">
      {["w-3/4", "w-2/3", "w-1/2"].map((width, i) => (
        <div
          key={width}
          className={`flex items-center gap-2.5 px-3 py-2.5 ${i > 0 ? "border-t border-line-2" : ""}`}
        >
          <Skeleton className="h-5 w-5 flex-none rounded-full" />
          <Skeleton className={`h-3 ${width}`} />
        </div>
      ))}
    </div>
  );
}
