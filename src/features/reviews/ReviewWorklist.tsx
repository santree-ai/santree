import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import type { PrDetail, ReviewDraft, ReviewPr, ReviewWorkItem } from "../../bindings";
import { CheckIcon, GitHubLogo, PencilIcon, SparklesIcon, TrashIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import {
  useAddReviewWorkItem,
  useDeleteReviewWorkItem,
  useReviewWorkItems,
  useUpdateReviewWorkItem,
} from "../../lib/queries";

export function ReviewWorklist({
  pr,
  detail,
  drafts,
  onFocusFile,
  onStartWork,
}: {
  pr: ReviewPr;
  detail: PrDetail | undefined;
  drafts: ReviewDraft[];
  /** Show a queued item's source file — each host jumps its own way. */
  onFocusFile: (path: string, line?: number | null) => void;
  /** Hand the open items to an agent (see {@link useStartWorkInWorktree} and
   *  {@link useStartWorkFromReviews} — the hosts differ on whether the PR's
   *  worktree has to be created first). */
  onStartWork: () => void;
}) {
  const { data: items = [] } = useReviewWorkItems(pr.repo, pr.number);
  const add = useAddReviewWorkItem(pr.repo, pr.number);
  const update = useUpdateReviewWorkItem(pr.repo, pr.number);
  const remove = useDeleteReviewWorkItem(pr.repo, pr.number);
  const [body, setBody] = useState("");
  const openCount = items.filter((item) => !item.done).length;

  function addManual() {
    if (!body.trim()) return;
    add.mutate({
      id: crypto.randomUUID(),
      body,
      source: "manual",
      sourceId: null,
      path: null,
      line: null,
      startLine: null,
      onRight: null,
    });
    setBody("");
  }

  return (
    <section className="mb-6 border-b border-hairline pb-5">
      <div className="mb-2.5 flex items-center gap-2">
        <div className="font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">Queue</div>
        {items.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-4">{openCount} open</span>
        )}
        {/* Wrapped, not passed straight through: the Trees launcher takes an
            optional agent override, and handing it to onClick would pass the
            click event as that agent. */}
        {openCount > 0 && (
          <Button size="sm" variant="primary" onClick={() => onStartWork()}>
            Start work
          </Button>
        )}
      </div>

      <div className="mb-2 flex gap-2">
        <input
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addManual();
          }}
          placeholder="Add something to improve…"
          aria-label="New review improvement"
          className="min-w-0 flex-1 rounded-md border border-line-2 bg-input px-2.5 py-1.5 text-[12px] text-fg outline-none focus:border-accent"
        />
        {/* The same spark every other queue action wears — see {@link QueueAction}.
            This one keeps its own Button because the body comes from the input
            beside it, not from a fixed source. */}
        <Button size="sm" onClick={addManual} disabled={!body.trim() || add.isPending}>
          <SparklesIcon size={11} /> Add
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-4">
          Add notes here, or use “Add to queue” on a check, a comment or an AI draft.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
            <WorkItem
              key={item.id}
              item={item}
              pr={pr}
              detail={detail}
              draft={drafts.find((draft) => draft.id === item.sourceId)}
              onFocusFile={onFocusFile}
              onUpdate={(next) => update.mutate(next)}
              onDelete={() => remove.mutate(item.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WorkItem({
  item,
  pr,
  detail,
  draft,
  onUpdate,
  onDelete,
  onFocusFile,
}: {
  item: ReviewWorkItem;
  pr: ReviewPr;
  detail: PrDetail | undefined;
  draft: ReviewDraft | undefined;
  onUpdate: (item: { id: string; body: string; done: boolean }) => void;
  onDelete: () => void;
  onFocusFile: (path: string, line?: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const thread = detail?.threads.find((candidate) => candidate.replyToId === item.sourceId);
  const liveBody = thread?.comments.at(-1)?.body ?? draft?.body;
  const anchor = item.path
    ? `${item.path}${item.line ? `:${item.startLine && item.startLine < item.line ? `${item.startLine}-` : ""}${item.line}` : ""}`
    : null;
  const githubUrl =
    item.source === "githubThread" && item.sourceId
      ? `${pr.url}#discussion_r${item.sourceId}`
      : null;

  return (
    <div
      className={`rounded-md border border-line-2 bg-raised px-2.5 py-2 ${item.done ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label={item.done ? "Mark improvement open" : "Mark improvement done"}
          onClick={() => onUpdate({ id: item.id, body: item.body, done: !item.done })}
          className={`mt-0.5 grid size-4 flex-none place-items-center rounded border ${item.done ? "border-status-green bg-status-green text-black" : "border-line-3"}`}
        >
          {item.done && <CheckIcon size={10} />}
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={body}
              onChange={(event) => setBody(event.target.value)}
              onBlur={() => {
                if (body.trim() && body !== item.body)
                  onUpdate({ id: item.id, body, done: item.done });
                setEditing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setBody(item.body);
                  setEditing(false);
                }
              }}
              aria-label="Edit review improvement"
              className="w-full rounded border border-accent bg-input px-1.5 py-0.5 text-[12px] outline-none"
            />
          ) : (
            <p className={`text-[12px] leading-snug text-fg-2 ${item.done ? "line-through" : ""}`}>
              {item.body}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[9.5px] text-muted-4">
            {anchor && item.path && (
              <button
                type="button"
                onClick={() => onFocusFile(item.path as string, item.line)}
                className="truncate font-mono text-accent hover:underline"
                title="Show this source in the diff"
              >
                {anchor}
              </button>
            )}
            {githubUrl && (
              <button
                type="button"
                onClick={() => void openUrl(githubUrl)}
                className="flex items-center gap-1 text-accent hover:underline"
              >
                <GitHubLogo size={10} /> Source
              </button>
            )}
            {item.source === "aiDraft" && <span>AI draft source</span>}
            {liveBody && liveBody.trim() !== item.body.trim() && (
              <span className="truncate" title={liveBody}>
                Latest: {liveBody}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label="Edit improvement"
          className="text-muted-4 hover:text-fg-2"
        >
          <PencilIcon size={11} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete improvement"
          className="text-muted-4 hover:text-danger"
        >
          <TrashIcon size={11} />
        </button>
      </div>
    </div>
  );
}
