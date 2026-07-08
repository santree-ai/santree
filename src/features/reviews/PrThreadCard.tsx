/**
 * One inline review-comment thread, rendered GitHub-style: a header row that
 * shows the anchor (file:line), a resolved/outdated badge, and the comment count,
 * with the comments below. **Resolved threads start collapsed** to just the
 * header (click to expand); unresolved threads start open. Used both anchored in
 * the diff (via {@link PrFileDiff}'s `renderExtendLine`) and in the sidebar's
 * "other files" list.
 */
import { useState } from "react";

import type { PrThread } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { CheckIcon, ChevronDownIcon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { successColor } from "../../theme/colors";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function PrThreadCard({ thread }: { thread: PrThread }) {
  // Resolved conversations collapse to their header by default (GitHub's UI);
  // everything else opens so unresolved feedback is visible without a click.
  const [open, setOpen] = useState(!thread.isResolved);
  const anchor = `${basename(thread.path)}${thread.line != null ? `:${thread.line}` : ""}`;
  const count = thread.comments.length;

  return (
    <div
      className="border-l-2 bg-app"
      style={{ borderColor: thread.isResolved ? successColor : "var(--accent)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={open ? "Collapse conversation" : "Expand conversation"}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
      >
        <ChevronDownIcon
          size={11}
          className={`flex-none text-muted-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {thread.isResolved && <CheckIcon size={12} className="flex-none text-status-green" />}
        <span className="font-mono text-[10.5px] text-muted-3">{anchor}</span>
        {thread.isResolved && <span className="text-[10px] text-status-green">Resolved</span>}
        {thread.isOutdated && (
          <span className="rounded bg-input px-1 py-px text-[9.5px] text-muted-4">Outdated</span>
        )}
        <span className="ml-auto flex-none text-[10.5px] text-muted-4">
          {count} comment{count === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3 pt-0.5 pb-2.5">
          {thread.comments.map((c, i) => (
            <div key={`${c.author}-${c.createdAt}-${i}`} className="flex gap-2">
              <Avatar name={c.author} src={c.authorAvatarUrl} size={18} />
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 text-[11px] font-medium text-fg-2">{c.author}</div>
                <div className="text-[12px]">
                  <Markdown>{c.body}</Markdown>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
