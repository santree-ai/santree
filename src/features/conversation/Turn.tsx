/** One turn of a conversation, and the list of them.
 *
 *  A finished turn folds to what a reader scans for — the prompt, the agent's
 *  final reply, and a footer of what it took ("Worked for 1m 12s · 14 steps ·
 *  3 files +40 −12 · 18.2k tokens") — and opens onto its work. The latest turn
 *  stays open. Inside the work, consecutive tool calls fold into one sentence
 *  ("Read 3 files, searched twice, ran 1 command"); while the agent is working
 *  the current run also shows its last few steps. A run too short to be worth
 *  folding is drawn as its steps.
 *
 *  Turns are set apart by space, not rules: the prompt's bubble is what starts
 *  one.
 *
 *  Each turn is memoized on its group, which the journal keeps by identity, so a
 *  read that appends to the live turn re-renders that turn and nothing else. */
import { memo, type ReactNode, useEffect, useMemo, useState } from "react";

import type { ConversationItem } from "../../bindings";
import { ChevronDownIcon, ListIcon } from "../../components/icons";
import type { TurnGroup } from "../../lib/conversationJournal";
import { formatCompact } from "../../lib/format";
import { DiffStat } from "../reviews/DiffStat";
import { AgentItem, NoticeItem, QueuedItem, ReasoningItem, UserItem } from "./Items";
import { ActivityRow } from "./Row";
import { durationLabel } from "./scope";
import { AskCard, StepIcon, ToolRow, toolIcon } from "./ToolCard";
import {
  buildTurn,
  type ItemOf,
  isKind,
  runSentence,
  type Segment,
  segments,
  standsAlone,
  type TurnModel,
  totalTokens,
} from "./turns";

/** How many of the current run's latest steps a working turn shows unfolded. */
const LIVE_TAIL = 3;

/** A run of at most this many steps is drawn as its steps: folding it would
 *  hide as much as it saves. */
const FOLD_FROM = 3;

/** How many turns a long conversation draws before "Show earlier". */
const TURN_PAGE = 40;

/** The turns, latest last. Long conversations draw their latest {@link TURN_PAGE}
 *  and offer the rest a page at a time. */
export function TurnList({
  turns,
  working,
  nested = false,
  tail,
  onShowEarlier,
}: {
  turns: readonly TurnGroup[];
  /** The agent is working now — on the latest turn, by construction. */
  working: boolean;
  /** A subagent's conversation inside its call: the same page, tighter. */
  nested?: boolean;
  /** Drawn at the end of the latest turn, above its footer: what the record
   *  doesn't have yet (the reply Claude is writing, how the turn failed). */
  tail?: ReactNode;
  /** Called just before earlier turns are added above, so a scroller can keep
   *  the reader's place. */
  onShowEarlier?: () => void;
}) {
  const [shown, setShown] = useState(TURN_PAGE);
  const hidden = Math.max(0, turns.length - shown);
  const visible = hidden > 0 ? turns.slice(hidden) : turns;
  return (
    <div className={`flex flex-col ${nested ? "gap-6" : "gap-10"}`}>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            onShowEarlier?.();
            setShown((n) => n + TURN_PAGE);
          }}
          className="cursor-pointer self-center rounded-full border border-line-2 px-3 py-1 text-sm font-medium text-muted-3 transition-colors hover:border-line-strong hover:text-fg-2"
        >
          Show {Math.min(hidden, TURN_PAGE)} earlier {hidden === 1 ? "turn" : "turns"}
        </button>
      )}
      {visible.map((group, i) => (
        <TurnView
          key={group.turn}
          group={group}
          latest={hidden + i === turns.length - 1}
          working={working && hidden + i === turns.length - 1}
          tail={hidden + i === turns.length - 1 ? tail : undefined}
        />
      ))}
    </div>
  );
}

const TurnView = memo(function TurnView({
  group,
  latest,
  working,
  tail,
}: {
  group: TurnGroup;
  latest: boolean;
  /** The agent is working on this turn now. */
  working: boolean;
  tail?: ReactNode;
}) {
  const model = useMemo(() => buildTurn(group.items), [group.items]);
  // A turn that stops being the latest folds — unless the reader opened or shut
  // it themselves, which sticks.
  const [chosen, setChosen] = useState<boolean | null>(null);
  // Turn 0 is what came before any prompt (a command, injected context): there
  // is nothing to fold it down to.
  const foldable = model.prompt !== null && model.work.length > 0;
  const open = !foldable || (chosen ?? latest);
  const ending = !open && !model.answer ? howItEnded(model.work) : null;
  return (
    <section
      aria-label={model.prompt ? "Turn" : "Before the first prompt"}
      className="flex flex-col gap-3"
    >
      {model.prompt && <UserItem item={model.prompt} />}
      {open && model.work.length > 0 && <WorkList items={model.work} working={working} />}
      {ending && <ItemView item={ending} working={false} />}
      {model.answer && <AgentItem item={model.answer} />}
      {tail}
      {model.prompt && (
        <TurnFooter
          model={model}
          working={working}
          open={open}
          onToggle={foldable ? () => setChosen(!open) : undefined}
        />
      )}
      {model.after.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {model.after.map((item) => (
            <ItemView key={item.id} item={item} working={false} />
          ))}
        </div>
      )}
    </section>
  );
});

/** A folded turn with no reply still says how it ended: the warning or error
 *  that stopped it, or the plan or question it was left on. */
function howItEnded(items: readonly ConversationItem[]): ConversationItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if ((isKind(item, "notice") && item.body.tone !== "Info") || standsAlone(item)) return item;
  }
  return null;
}

function WorkList({ items, working }: { items: ConversationItem[]; working: boolean }) {
  const segs = useMemo(() => segments(items), [items]);
  // The run a working agent is in: its last one, whatever prose or notice has
  // landed after it.
  let lastRun = -1;
  segs.forEach((seg, i) => {
    if (seg.kind === "run") lastRun = i;
  });
  return (
    <div className="flex flex-col gap-1.5">
      {segs.map((seg, i) =>
        seg.kind === "item" ? (
          <ItemView key={seg.item.id} item={seg.item} working={working} />
        ) : seg.items.length < FOLD_FROM ? (
          <div key={seg.key} className="flex flex-col">
            {seg.items.map((item) => (
              <StepView key={item.id} item={item} live={working} />
            ))}
          </div>
        ) : (
          <RunRow key={seg.key} run={seg} working={working} current={working && i === lastRun} />
        ),
      )}
    </div>
  );
}

function ItemView({ item, working }: { item: ConversationItem; working: boolean }) {
  if (isKind(item, "user")) return <UserItem item={item} />;
  if (isKind(item, "agent")) return <AgentItem item={item} />;
  if (isKind(item, "reasoning")) return <ReasoningItem item={item} />;
  if (isKind(item, "notice")) return <NoticeItem item={item} />;
  if (isKind(item, "queued")) return <QueuedItem item={item} />;
  if (isKind(item, "tool")) return <AskCard item={item} live={working} />;
  return null;
}

/** One step of a run: a call or a thought. */
function StepView({ item, live }: { item: ConversationItem; live: boolean }) {
  if (isKind(item, "tool")) return <ToolRow item={item} live={live} />;
  if (isKind(item, "reasoning")) return <ReasoningItem item={item} />;
  return null;
}

/** A run of tool calls as one sentence, opening onto each call. Its icon is
 *  its calls' kind when they share one. */
function RunRow({
  run,
  working,
  current,
}: {
  run: Extract<Segment, { kind: "run" }>;
  working: boolean;
  /** The run the working agent is in right now: its latest steps show. */
  current: boolean;
}) {
  const [open, setOpen] = useState(false);
  const calls = run.items.filter((item): item is ItemOf<"tool"> => isKind(item, "tool"));
  const sentence = runSentence(calls.map((c) => c.body));
  const failed = calls.filter((c) => c.body.status === "Failed").length;
  const denied = calls.filter((c) => c.body.status === "Denied").length;
  // A call with no result yet: running while the agent works, unanswered after.
  const pending = calls.some((c) => c.body.status === "Running");
  const kinds = new Set(calls.map((c) => c.body.input.kind));
  const icon = kinds.size === 1 && calls[0] ? toolIcon(calls[0].body) : <ListIcon size={12} />;
  const rows = open ? run.items : current ? run.items.slice(-LIVE_TAIL) : [];
  const earlier = open ? 0 : run.items.length - rows.length;
  return (
    <div className="min-w-0">
      <ActivityRow
        icon={
          <StepIcon
            status={
              pending && working
                ? "Running"
                : failed > 0
                  ? "Failed"
                  : denied > 0
                    ? "Denied"
                    : pending
                      ? "Running"
                      : "Done"
            }
            live={working}
            icon={icon}
          />
        }
        meta={
          failed > 0 || denied > 0 ? (
            <>
              {failed > 0 && <span className="text-status-red">{failed} failed</span>}
              {denied > 0 && <span className="text-status-amber">{denied} denied</span>}
            </>
          ) : undefined
        }
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        {sentence}
      </ActivityRow>
      {rows.length > 0 && (
        <div className="mt-0.5 mb-1 ml-[7px] flex flex-col border-l border-line pl-4">
          {earlier > 0 && (
            <div className="py-[3px] pl-6 text-sm text-muted-4">
              {earlier} earlier {earlier === 1 ? "step" : "steps"}
            </div>
          )}
          {rows.map((item) => (
            <StepView key={item.id} item={item} live={working} />
          ))}
        </div>
      )}
    </div>
  );
}

/** What a turn took. Its step count is also the fold's toggle. */
function TurnFooter({
  model,
  working,
  open,
  onToggle,
}: {
  model: TurnModel;
  working: boolean;
  open: boolean;
  onToggle?: () => void;
}) {
  const { stats } = model;
  const startedAt = model.prompt?.atMs ?? null;
  const live = working && !model.end && startedAt !== null;
  const parts: ReactNode[] = [];
  if (live) {
    parts.push(
      <span key="time" className="flex items-center gap-1.5 text-muted-3">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-green" />
        <span>
          Working for <LiveElapsed since={startedAt} />
        </span>
      </span>,
    );
  } else if (stats.durationMs !== null && stats.durationMs > 0) {
    parts.push(<span key="time">Worked for {durationLabel(stats.durationMs)}</span>);
  }
  const steps = stats.steps === 1 ? "1 step" : `${stats.steps} steps`;
  if (onToggle) {
    parts.push(
      <button
        key="steps"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="-mx-1 flex cursor-pointer items-center gap-1 rounded px-1 transition-colors hover:bg-hover hover:text-fg-2"
      >
        {stats.steps > 0 ? steps : "Details"}
        <ChevronDownIcon size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>,
    );
  } else if (stats.steps > 0) {
    parts.push(<span key="steps">{steps}</span>);
  }
  if (stats.files.count > 0) {
    parts.push(
      <span key="files" className="flex items-center gap-1.5">
        {stats.files.count === 1 ? "1 file" : `${stats.files.count} files`}
        <DiffStat
          additions={stats.files.added}
          deletions={stats.files.removed}
          className="text-xs"
        />
      </span>,
    );
  }
  if (stats.usage) {
    const usage = stats.usage;
    const total = totalTokens(usage);
    parts.push(
      <span
        key="tokens"
        title={`input ${formatCompact(usage.input)} · output ${formatCompact(usage.output)} · cache read ${formatCompact(usage.cacheRead)} · cache write ${formatCompact(usage.cacheWrite)}`}
      >
        {formatCompact(total)} tokens
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-4 tabular-nums">
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<Dot key={`dot-${i}`} />, part]))}
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-5">
      ·
    </span>
  );
}

/** A running clock from `since`, ticking each second while mounted. */
function LiveElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{durationLabel(Math.max(0, now - since))}</>;
}
