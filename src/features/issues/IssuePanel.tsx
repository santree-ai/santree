/**
 * The single right-panel view for the focused issue: header + an "Add to queue"
 * control, then its dependencies (blocked by / blocks) and the Linear body +
 * comment thread. There's no separate Inspector tab — everything about the issue
 * lives here. The detail is fetched lazily (and prewarmed on graph hover).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo } from "react";

import type { Task } from "../../bindings";
import { Avatar } from "../../components/Avatar";
import { DiscussionContent } from "../../components/IssueDiscussion";
import {
  BlockedIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  LinearLogo,
  PlusIcon,
} from "../../components/icons";
import { Dot, EmptyState, Skeleton, Spinner } from "../../components/primitives";
import { useTriageDetail } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { palette, statusColor, statusLabel } from "../../theme/colors";
import { BlockerRow } from "./BlockerRow";
import { sessionState, useIssues } from "./model";
import { TaskNotes } from "./TaskNotes";

interface RefRow {
  id: string;
  title: string;
  color: string;
  state: string;
  grayed: boolean;
  foreign: string | null;
}

/** A light skeleton for just the body text — keeps the header + dependencies in
 *  place while a freshly-selected issue's detail loads (no full-pane flash). */
function BodySkeleton() {
  return (
    <div className="space-y-2.5">
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-4 h-24 w-full rounded-lg" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-2">
      {children}
    </div>
  );
}

export function IssuePanel() {
  const {
    tasks,
    byId,
    focusId,
    selected,
    selectedEligible,
    isEligible,
    toggle,
    setFocus,
    clearSelection,
    sessionByTask,
    revealInGraph,
    toggleRightPanel,
  } = useIssues();
  const { activeRepo } = useApp();
  const focus = tasks.find((t) => t.id === focusId) ?? tasks[0];
  const { data: detail } = useTriageDetail(activeRepo, focus?.id ?? null);

  // "Open in graph" from a dependency row: focus + pan, and scroll the sidebar row in.
  const openInGraph = useCallback(
    (id: string) => {
      revealInGraph(id);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-issue-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [revealInGraph],
  );

  const { blockedBy, blocks } = useMemo(() => {
    if (!focus) return { blockedBy: [] as RefRow[], blocks: [] as RefRow[] };
    return {
      blockedBy: focus.blockedBy.map<RefRow>((id) => {
        const t = byId.get(id);
        return {
          id,
          title: t?.title ?? "",
          color: t ? statusColor[t.status] : palette.slate,
          state: t ? statusLabel[t.status] : "Unknown",
          grayed: !t?.actionable,
          foreign: t && t.project !== focus.project ? t.project : null,
        };
      }),
      blocks: tasks
        .filter((t) => t.blockedBy.includes(focus.id))
        .map<RefRow>((t) => ({
          id: t.id,
          title: t.title,
          color: statusColor[t.status],
          state: statusLabel[t.status],
          grayed: !t.actionable,
          foreign: t.project !== focus.project ? t.project : null,
        })),
    };
  }, [focus, tasks, byId]);

  if (!focus) {
    return <EmptyState title="Select an issue to see its details." />;
  }

  const ready = detail?.id === focus.id ? detail : undefined;
  const session = sessionByTask.get(focus.id);
  const state = sessionState(session);
  const running = state === "running";
  const done = state === "done";
  const queued = !!selected[focus.id] && !session;
  const eligible = isEligible(focus);
  const noBody = !!ready && ready.description.trim() === "" && ready.comments.length === 0;
  const hasDeps = blockedBy.length > 0 || blocks.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedEligible.length > 0 && (
        <QueueBar
          items={selectedEligible}
          focusId={focus.id}
          onFocus={setFocus}
          onRemove={toggle}
          onClear={clearSelection}
        />
      )}
      <div className="flex-none border-b border-hairline px-5 pt-4 pb-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-2">{focus.id}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
            <Dot color={statusColor[focus.status]} size={7} />
            {statusLabel[focus.status]}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {ready && (
              <button
                type="button"
                onClick={() => openUrl(ready.url)}
                title="Open in Linear"
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-input px-2 py-1 text-[10.5px] text-muted-2 hover:text-fg-2"
              >
                <LinearLogo size={11} className="text-[color:var(--linear-brand)]" />
                Open
              </button>
            )}
            <button
              type="button"
              onClick={toggleRightPanel}
              title="Collapse panel (⌘L)"
              aria-label="Collapse panel"
              className="flex flex-none cursor-pointer items-center rounded p-1 text-muted-4 hover:text-fg-2"
            >
              <span className="inline-block -rotate-90">
                <ChevronDownIcon size={13} />
              </span>
            </button>
          </div>
        </div>
        <div className="text-[15px] leading-[1.3] font-semibold text-fg-bright">{focus.title}</div>
        {ready && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[10.5px] text-muted-3">
            <span className="flex items-center gap-1.5">
              <Avatar name={ready.author} src={ready.authorAvatarUrl} size={15} />
              {ready.author}
            </span>
            <span className="text-muted-5">·</span>
            <span>{ready.created}</span>
            {ready.labels.map((l) => (
              <span
                key={l}
                className="rounded border border-line-2 bg-input px-1.5 py-px font-mono text-[9.5px] text-muted-2"
              >
                {l}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3">
          <QueueControl
            running={running}
            done={done}
            queued={queued}
            eligible={eligible}
            focusStatus={focus.status}
            actionable={focus.actionable}
            pr={session?.pr}
            onToggle={() => toggle(focus.id)}
          />
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
        {hasDeps && (
          <div className="mb-5 space-y-3.5">
            {blockedBy.length > 0 && (
              <div>
                <SectionHeader>
                  <BlockedIcon size={12} className="text-muted-3" />
                  Blocked by
                </SectionHeader>
                <div className="space-y-1.5">
                  {blockedBy.map((b) => (
                    <BlockerRow
                      key={b.id}
                      id={b.id}
                      title={b.title}
                      color={b.color}
                      state={b.state}
                      grayed={b.grayed}
                      foreignProject={b.foreign}
                      onOpenInGraph={openInGraph}
                    />
                  ))}
                </div>
              </div>
            )}
            {blocks.length > 0 && (
              <div>
                <SectionHeader>Blocks</SectionHeader>
                <div className="space-y-1.5">
                  {blocks.map((b) => (
                    <BlockerRow
                      key={b.id}
                      id={b.id}
                      title={b.title}
                      color={b.color}
                      state={b.state}
                      grayed={b.grayed}
                      foreignProject={b.foreign}
                      onOpenInGraph={openInGraph}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!ready ? (
          <BodySkeleton />
        ) : noBody ? (
          hasDeps ? null : (
            <EmptyState
              className="pt-10"
              title="No description"
              subtitle="This issue has no body or comments in Linear yet."
            />
          )
        ) : (
          <DiscussionContent detail={ready} />
        )}
      </div>

      {/* Pinned below the scroll area so it's always reachable, even with a long
          comment thread. */}
      <TaskNotes key={focus.id} repo={activeRepo} taskId={focus.id} />
    </div>
  );
}

/**
 * A compact strip of the currently-queued tickets, pinned above the issue detail
 * so the launch queue stays visible while you read any one ticket. Click a chip
 * to focus that ticket; the × removes it from the queue. The focused ticket's
 * chip is highlighted so you can tell where you are within the queue.
 */
function QueueBar({
  items,
  focusId,
  onFocus,
  onRemove,
  onClear,
}: {
  items: Task[];
  focusId: string;
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex-none border-b border-hairline bg-well px-4 pt-2.5 pb-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">Queue</span>
        <span className="font-mono text-[10px] text-muted-3">{items.length}</span>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto cursor-pointer text-[10.5px] text-muted-4 hover:text-muted"
        >
          clear
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t) => {
          const active = t.id === focusId;
          return (
            <span
              key={t.id}
              className="flex items-center gap-1 rounded-md border py-0.5 pr-1 pl-1.5"
              style={
                active
                  ? {
                      borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
                      background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                    }
                  : { borderColor: "var(--color-line-2)", background: "var(--color-input)" }
              }
            >
              <button
                type="button"
                onClick={() => onFocus(t.id)}
                title={t.title}
                className="flex cursor-pointer items-center gap-1.5"
              >
                <Dot color={statusColor[t.status]} size={6} />
                <span
                  className="font-mono text-[10px]"
                  style={{ color: active ? "var(--accent-text)" : "var(--color-fg-3)" }}
                >
                  {t.id}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(t.id)}
                aria-label={`Remove ${t.id} from queue`}
                className="flex cursor-pointer items-center rounded p-0.5 text-muted-4 hover:text-fg-2"
              >
                <CloseIcon size={10} />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** The "Add to queue" button / status chip for the focused issue. */
function QueueControl({
  running,
  done,
  queued,
  eligible,
  focusStatus,
  actionable,
  pr,
  onToggle,
}: {
  running: boolean;
  done: boolean;
  queued: boolean;
  eligible: boolean;
  focusStatus: keyof typeof statusColor;
  actionable: boolean;
  pr?: number;
  onToggle: () => void;
}) {
  if (running) {
    return (
      <div
        className="flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-medium"
        style={{
          color: "var(--accent-text)",
          background: "color-mix(in srgb, var(--accent) 10%, transparent)",
          borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
        }}
      >
        <Spinner size={12} />
        Agent working…
      </div>
    );
  }
  if (done) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-status-green/30 bg-status-green/10 px-3 py-2 text-[12px] font-medium text-status-green">
        <CheckIcon size={13} />
        PR #{pr} opened
      </div>
    );
  }
  if (eligible) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title={queued ? "Remove from queue" : "Add to the work queue"}
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-semibold transition-[filter,background] hover:brightness-105"
        style={{
          color: "var(--accent-text)",
          background: queued
            ? "color-mix(in srgb, var(--accent) 20%, transparent)"
            : "color-mix(in srgb, var(--accent) 11%, transparent)",
          borderColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
        }}
      >
        {queued ? <CheckIcon size={14} /> : <PlusIcon size={14} />}
        {queued ? "Queued" : "Add to queue"}
      </button>
    );
  }
  // Not launchable — say why, disabled.
  const reason = !actionable
    ? "Not assigned to you"
    : focusStatus === "InProgress" || focusStatus === "InReview" || focusStatus === "Done"
      ? `${statusLabel[focusStatus]} — can't queue`
      : "Blocked — resolve blockers first";
  return (
    <div className="flex cursor-default items-center justify-center gap-1.5 rounded-lg border border-line-2 bg-input px-3 py-2 text-[12px] font-medium text-muted-3">
      {reason}
    </div>
  );
}
