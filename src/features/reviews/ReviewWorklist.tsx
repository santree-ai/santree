/**
 * The PR's AI work queue: everything one agent run has to answer for, in one list.
 *
 * Four things fill it and only one of them is the user's own words. A manual note
 * is written here; a check, a review thread and an AI draft are *references* —
 * the backend authors their body from the source when they are queued
 * (`add_review_work_item`) and re-resolves that source again when the agent
 * starts (`review_ai::fix_launch`). So a row carries an identity, not just a
 * sentence, and it shows it: one leading glyph saying where it came from, and one
 * metadata line saying which check / whose comment / which agent — read live off
 * the PR detail already in scope, so a red check that has since gone green says
 * so even though its queued sentence can't.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, type ReactNode, useState } from "react";

import type { PrDetail, ReviewDraft, ReviewPr, ReviewWorkItem } from "../../bindings";
import { CheckIcon, GitHubLogo, PencilIcon, SparklesIcon, TrashIcon } from "../../components/icons";
import { Button } from "../../components/primitives";
import {
  useAddReviewWorkItem,
  useDeleteReviewWorkItem,
  useReviewWorkItems,
  useUpdateReviewWorkItem,
} from "../../lib/queries";
import { checkStatusMeta, palette } from "../../theme/colors";

export function ReviewWorklist({
  pr,
  detail,
  drafts,
  onFocusFile,
  onStartWork,
  startingWork = false,
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
  /** That launch is running. It takes seconds (the prompt is rendered from the
   *  live PR), and the tab it opens can be behind whatever the reader is looking
   *  at, so the button that started it is the one thing guaranteed on screen. */
  startingWork?: boolean;
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
          <Button size="sm" variant="primary" onClick={() => onStartWork()} disabled={startingWork}>
            {startingWork ? "Starting…" : "Start work"}
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

/** One piece of a row's metadata line, keyed so the separator can be woven
 *  between pieces without each piece knowing its neighbours. */
interface MetaPiece {
  key: string;
  node: ReactNode;
}

/**
 * Where a row came from, said in the two slots the row shape gives it: the
 * leading glyph and the metadata line.
 *
 * Each source wears the mark it already wears elsewhere in the app — a check its
 * status glyph (the Checks tab's), a thread the GitHub logomark, an AI draft the
 * queue's own spark, a note the pencil that edits it. Every join is against data
 * the pane already holds, so a row costs no fetch and still tells the truth:
 * the body froze when the item was queued, but the check's colour, the thread's
 * resolved flag and the draft's staleness are read live.
 */
function rowFacts(
  item: ReviewWorkItem,
  detail: PrDetail | undefined,
  draft: ReviewDraft | undefined,
): { glyph: ReactNode; label: string; meta: MetaPiece[] } {
  switch (item.source) {
    case "check": {
      // `sourceId` *is* the check's name: the only identity that survives a
      // re-run or a force-push, which is what makes this join possible at all.
      const check = detail?.checks.find((candidate) => candidate.name === item.sourceId);
      const status = check ? checkStatusMeta[check.status] : null;
      const meta: MetaPiece[] = [
        { key: "name", node: <CheckLink name={item.sourceId ?? "check"} url={check?.url} /> },
      ];
      if (status) {
        meta.push({
          key: "status",
          node: <span style={{ color: status.color }}>{status.label}</span>,
        });
      } else if (detail) {
        // Detail is loaded and the name isn't in it — the job was renamed or
        // dropped. Saying nothing would leave the frozen sentence looking live.
        meta.push({ key: "status", node: <span>not on this PR any more</span> });
      }
      if (check?.description) meta.push({ key: "app", node: <span>{check.description}</span> });
      return {
        glyph: (
          <span aria-hidden style={status ? { color: status.color } : undefined}>
            {status?.glyph ?? checkStatusMeta.Neutral.glyph}
          </span>
        ),
        label: status ? `Check, ${status.label}` : "Check",
        meta,
      };
    }
    case "githubThread": {
      const thread = detail?.threads.find((candidate) => candidate.replyToId === item.sourceId);
      const author = thread?.comments[0]?.author;
      const meta: MetaPiece[] = [];
      if (author) meta.push({ key: "author", node: <span>@{author}</span> });
      if (thread?.isResolved) meta.push({ key: "resolved", node: <span>Resolved</span> });
      // Outdated is the one that changes what the agent can do with it: the
      // anchor no longer matches any line of the current diff.
      if (thread?.isOutdated) {
        meta.push({
          key: "outdated",
          node: <span style={{ color: palette.amber }}>Outdated</span>,
        });
      }
      return {
        glyph: <GitHubLogo size={10} className="text-muted-3" />,
        label: "Review comment",
        meta,
      };
    }
    case "aiDraft": {
      const stale = !!detail?.headSha && !!draft && draft.headSha !== detail.headSha;
      const meta: MetaPiece[] = [];
      if (draft) meta.push({ key: "agent", node: <span>{draft.agentKind}</span> });
      if (stale) {
        meta.push({
          key: "stale",
          node: (
            <span
              style={{ color: palette.amber }}
              title="Written against an earlier commit, so its lines may point at different code now."
            >
              Older commit
            </span>
          ),
        });
      }
      return {
        // The queue's own spark, in the purple every AI draft wears — not the
        // agent's logomark, which at this size is a smudge (see ReviewDraftCard).
        glyph: (
          <span style={{ color: palette.purple }} className="flex">
            <SparklesIcon size={10} />
          </span>
        ),
        label: "AI draft",
        meta,
      };
    }
    case "manual":
      // A note you typed. The only row whose body is nobody else's, hence the
      // only one that carries the pencil — named explicitly rather than as the
      // default, so a fifth source has to say what it looks like.
      return { glyph: <PencilIcon size={10} className="text-muted-4" />, label: "Note", meta: [] };
  }
}

/** The check's name, linked to its run page when GitHub gave us one. */
function CheckLink({ name, url }: { name: string; url: string | null | undefined }) {
  if (!url) return <span className="truncate">{name}</span>;
  return (
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className="truncate text-accent hover:underline"
      title="Open this check's run on GitHub"
    >
      {name}
    </button>
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
  // Only your own note is yours to rewrite. The other three are references whose
  // body the backend authors from the source and re-resolves when the agent
  // starts (`review_ai::fix_launch`) — editing one here would diverge from the
  // thing it points at, silently, and the agent would still read the source.
  const editable = item.source === "manual";
  const facts = rowFacts(item, detail, draft);

  const pieces: MetaPiece[] = [];
  if (anchor && item.path) {
    pieces.push({
      key: "anchor",
      node: (
        <button
          type="button"
          onClick={() => onFocusFile(item.path as string, item.line)}
          className="truncate font-mono text-accent hover:underline"
          title="Show this source in the diff"
        >
          {anchor}
        </button>
      ),
    });
  }
  pieces.push(...facts.meta);
  if (githubUrl) {
    pieces.push({
      key: "source",
      node: (
        <button
          type="button"
          onClick={() => void openUrl(githubUrl)}
          className="flex items-center gap-1 text-accent hover:underline"
        >
          <GitHubLogo size={10} /> Source
        </button>
      ),
    });
  }
  // The source has moved on since this row was written: show what it says now.
  if (liveBody && liveBody.trim() !== item.body.trim()) {
    pieces.push({
      key: "latest",
      node: (
        <span className="truncate" title={liveBody}>
          Latest: {liveBody}
        </span>
      ),
    });
  }

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
        {/* One glyph slot, whatever the source: fixed size and always in flow, so
            four kinds of row still line up as one list. */}
        <span
          role="img"
          aria-label={facts.label}
          title={facts.label}
          className="mt-0.5 grid size-4 flex-none place-items-center text-[10px] leading-none"
        >
          {facts.glyph}
        </span>
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
          {pieces.length > 0 && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[9.5px] text-muted-4">
              {pieces.map((piece, index) => (
                <Fragment key={piece.key}>
                  {index > 0 && <span aria-hidden>·</span>}
                  {piece.node}
                </Fragment>
              ))}
            </div>
          )}
        </div>
        {editable && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit improvement"
            className="text-muted-4 hover:text-fg-2"
          >
            <PencilIcon size={11} />
          </button>
        )}
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
