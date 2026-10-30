/**
 * The Conversation view: a Claude Code session drawn from the record Claude
 * writes of it, while the real `claude` keeps running in its terminal.
 *
 * An agent tab switches between this and its terminal (`viewMode`); the PTY
 * never notices — it keeps running, at its size, in the terminal layer. What is
 * drawn here is display-only (COMPLIANCE.md, "Transcript reads"): the journal
 * comes from `conversation_read`, the header's state from the hooks' attention
 * level, its context and cost from the status line. The one thing that goes
 * the other way is the composer, which types only what the user wrote, through
 * the terminal's own input path (see `Composer`).
 *
 * A reading-width column: a sticky header, the journal scrolling under it, and
 * the composer pinned below. With no live tab (a past session) it is the same
 * page, read-only.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { ConversationTarget, SessionState } from "../../bindings";
import { Markdown } from "../../components/Markdown";
import { Button, EmptyState, Skeleton, TerminalActivity } from "../../components/primitives";
import { useSplitPane } from "../../components/split/SplitPaneContext";
import { levelOf, useDecayClock } from "../../lib/attention";
import {
  queryKeys,
  readSessionNow,
  useAgentProcesses,
  useConversation,
  useServerStatus,
  useSessionLiveText,
  useSessionStates,
  useSessionUsageLive,
} from "../../lib/queries";
import { serverStateView } from "../../lib/serverStatus";
import { useHeldFor } from "../../lib/useHeldFor";
import { type AgentEntry, liveTabFor, parseTermKey } from "../agents/registry";
import { useAgentEntries } from "../agents/useAgents";
import { subscribeInput } from "../terminal/inputWatch";
import { useTerminals } from "../terminal/TerminalsContext";
import type { DialogCard } from "./AnswerCard";
import {
  type AnsweredDialog,
  askOf,
  Composer,
  composerPhase,
  type LostPane,
  processFloor,
  type RecordedRow,
  type SendGate,
  type SendPane,
  type SendTarget,
  sendGate,
} from "./Composer";
import { type Echo, echoesShown, putBack, useTabComposer } from "./composerStore";
import { type Dialog, dialogOf, shownText } from "./dialog";
import { ConversationHeader } from "./Header";
import { ErrorNote, PROSE, UserItem } from "./Items";
import { Scroller } from "./Scroller";
import {
  type ConversationScope,
  ConversationScopeContext,
  firstLine,
  useConversationScope,
} from "./scope";
import { TurnList } from "./Turn";
import {
  BLOCKED,
  type InputState,
  inputLimit,
  inputStateOf,
  lowest,
  modeLimit,
  NO_LIMIT,
  recordLimit,
  truncatedLimit,
  versionLimit,
} from "./trust";
import {
  type ItemOf,
  isKind,
  latestPromptId,
  latestTodos,
  liveTextLanded,
  pendingAsk,
  turnEndedInError,
} from "./turns";

/** The page's one column: the ticket page's reading width. */
const COLUMN = "mx-auto w-full max-w-[760px] px-6";

/** How long a message the session took may go unshown, with Claude not
 *  working, before the view says so. */
export const ECHO_LATE_MS = 20_000;

/** The surface a live session belongs to: the tab's term key in its project. */
export interface LiveTab {
  repo: string;
  termKey: string;
}

export function ConversationView({
  target,
  live,
  shown = true,
  onResume,
}: {
  target: ConversationTarget;
  /** The tab whose session this is — its state, its composer. Absent for a
   *  past session, which is read-only. */
  live?: LiveTab;
  /** The face on screen (see `ConversationFace`): hidden, it reads nothing,
   *  holds no keyboard, and gives up a send's Enter not yet pressed. */
  shown?: boolean;
  /** The surface's own Resume for its agent, the one its terminal's lost
   *  notice uses: offered here too when the pane's session is lost. */
  onResume?: () => void;
}) {
  const pane = useSplitPane();
  const visible = (pane?.visible ?? true) && shown;
  const stableTarget = useStableTarget(target);
  const agent = useLiveAgent(live);
  const state = agent.entry?.state ?? null;
  const working = state === "active" || state === "delegating";
  const {
    data: journal,
    error,
    refetch,
  } = useConversation(stableTarget, null, {
    enabled: visible,
    working,
    followSession: agent.entry?.sessionId ?? null,
  });
  const { data: liveUsage } = useSessionUsageLive();
  const usage = liveUsage?.find((u) => u.sessionId === journal?.sessionId) ?? null;
  const { linkOf, holdRow, detachEmbeds, close } = useTerminals();
  const paneKey = agent.pane?.key ?? null;
  const { data: server } = useServerStatus();

  const renderSubagent = useCallback(
    (agentId: string, running: boolean) => (
      <SubagentConversation agentId={agentId} working={working && running} />
    ),
    [working],
  );
  const cwd = journal?.meta.cwd ?? null;
  const scope = useMemo<ConversationScope>(
    () => ({ target: stableTarget, cwd, renderSubagent }),
    [stableTarget, cwd, renderSubagent],
  );
  const todos = useMemo(() => (journal ? latestTodos(journal.items) : null), [journal]);
  const firstPrompt = journal?.items.find(
    (item): item is ItemOf<"user"> => isKind(item, "user") && item.body.origin === "Typed",
  );
  const fallbackTitle = firstPrompt
    ? firstLine(firstPrompt.body.text).slice(0, 120)
    : "Claude Code session";

  const remote = journal?.availability === "Remote";
  // The pane's link as well as the hooks: a pane that can't reach its session
  // shows its own overlay (Resume, Close) only over the terminal this view
  // hides, so the composer has to say it, and send nothing meanwhile. What it
  // shows follows the reconciled state; whether it may send, the record — which
  // also tells a delegating main thread's turn from background agents running
  // on after it ended.
  const { gate, recordedAt, reread, sendTarget, row, floor, paneId } = useSendTarget(live, paneKey);
  const phase = composerPhase(state, paneKey ? linkOf(paneKey) : null, gate.atPrompt);
  // The dialog Claude is showing, from its own hook: what replaces the
  // composer while it asks.
  const prompt = row?.prompt ?? null;
  const promptAt = prompt?.recordedAtMs ?? null;
  const dialog = useMemo(() => (prompt ? dialogOf(prompt) : null), [prompt]);
  const input = useInputState(paneId, promptAt);
  const dialogCard = dialogCardOf(phase === "asking", row, dialog, {
    floor,
    input,
    cliVersion: journal?.meta.cliVersion ?? null,
  });
  // What Claude asks, while it does: a question and a plan read as themselves,
  // not as a tool's permission.
  const ask =
    state === "permission" || state === "waiting"
      ? askOf(state, agent.entry?.message ?? null, journal ? pendingAsk(journal.items) : null)
      : null;
  const latestPrompt = useMemo(
    () => (journal ? latestPromptId(journal.items) : undefined),
    [journal],
  );
  const lastSeq = journal?.items.at(-1)?.seq ?? -1;
  const latestTurn = journal?.turns.at(-1);

  // The reply Claude is drawing right now, a few seconds ahead of its record
  // (MessageDisplay, for launches made with the view switched on): under the
  // running turn while Claude works, until the record has the prose it became.
  const liveText = useSessionLiveText(row?.sessionId ?? null, visible && working && !!live);
  const liveReply =
    liveText && working && journal && !liveTextLanded(liveText, latestTurn) ? liveText.text : null;
  // A turn that ended on an API error, by its hook (StopFailure): said at the
  // turn's end — unless the record has its own notice of it, which is drawn.
  const stopFailure =
    row?.recordedState === "idle" &&
    row.event === "StopFailure" &&
    row.message &&
    journal &&
    !turnEndedInError(latestTurn)
      ? row.message
      : null;

  // What was sent from here, drawn until the record shows it.
  const liveKey = live?.termKey ?? null;
  const echoes = useTabComposer(liveKey ?? "").echoes;
  useEffect(() => {
    if (liveKey && journal && echoes.length > 0) echoesShown(liveKey, journal.items);
  }, [liveKey, journal, echoes]);

  // Behind the terminal, nothing in here holds the keyboard: an inert subtree
  // is not guaranteed to give up the focus it has.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement;
    if (!shown && focused instanceof HTMLElement && root.current?.contains(focused)) {
      focused.blur();
    }
  }, [shown]);

  // A lost pane's way back, the terminal's own notice's (`TerminalLayer`): the
  // pane closes — a tab row keeps its binding through the gap, so its
  // conversation is the one resumed — and the surface resumes it in place.
  // Only on the click, never on santree's own decision.
  const lost = useMemo<LostPane | null>(() => {
    if (!live || !paneKey) return null;
    const end = () => {
      detachEmbeds(paneKey);
      close(paneKey);
    };
    return {
      close: end,
      resume: onResume
        ? () => {
            if (parseTermKey(live.termKey).tabId) holdRow(live.termKey);
            end();
            onResume();
          }
        : undefined,
      resumeBlocked: server ? serverStateView(server.state).blocksResume : undefined,
    };
  }, [live, paneKey, onResume, detachEmbeds, close, holdRow, server]);

  // The record starts with the first prompt, so before one there is nothing to
  // show and nothing amiss. Once a turn has cost something (the status line's
  // own figure), an empty record means it isn't being saved where it is read.
  const turnSeen = !live || (usage?.costUsd ?? 0) > 0;
  const pendingShown = echoes.length > 0 && !remote;

  return (
    <ConversationScopeContext.Provider value={scope}>
      <div ref={root} data-conversation className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <ConversationHeader
          meta={journal?.meta ?? null}
          fallbackTitle={fallbackTitle}
          live={
            agent.entry && agent.level
              ? { entry: agent.entry, level: agent.level, ask: ask?.kind ?? null }
              : null
          }
          usage={usage}
          todos={todos}
          mode={row?.permissionMode ?? null}
          effort={row?.effortLevel ?? null}
        />
        {journal && error && (
          <div className={`${COLUMN} flex-none pt-2`}>
            <p className="text-[11.5px] text-muted-3">
              Couldn't refresh the conversation.{" "}
              <button
                type="button"
                onClick={refetch}
                className="cursor-pointer font-medium text-fg-2 underline decoration-dotted underline-offset-2"
              >
                Retry
              </button>
            </p>
          </div>
        )}
        {!journal ? (
          error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <EmptyState
                className="flex-none"
                title="Couldn't read this conversation"
                subtitle={error.message}
              />
              <Button size="sm" variant="outline" onClick={refetch}>
                Try again
              </Button>
            </div>
          ) : (
            <ConversationSkeleton />
          )
        ) : journal.items.length === 0 && !pendingShown ? (
          journal.availability === "Ready" || (journal.availability === "NotFound" && !turnSeen) ? (
            <EmptyState
              title="No messages yet"
              subtitle={live ? "Send Claude a prompt, here or in the terminal." : undefined}
            />
          ) : (
            <Unavailable availability={journal.availability} />
          )
        ) : (
          <Scroller className={`${COLUMN} py-6`}>
            {(keepPlace) => (
              <>
                {journal.meta.truncated && (
                  <p className="mb-5 text-center text-[11px] text-muted-4">
                    The start of this conversation isn't shown: its record is larger than santree
                    reads.
                  </p>
                )}
                {/* Keyed by session: a `/clear` starts the turns over, and what
                    was opened in the old ones means nothing in the new. */}
                <TurnList
                  key={journal.sessionId ?? ""}
                  turns={journal.turns}
                  working={working}
                  onShowEarlier={keepPlace}
                  tail={
                    liveReply || stopFailure ? (
                      <>
                        {liveReply && <LiveReply text={liveReply} />}
                        {stopFailure && <ErrorNote text={shownText(stopFailure)} />}
                      </>
                    ) : undefined
                  }
                />
                {liveKey &&
                  pendingShown &&
                  echoes.map((echo) => (
                    <PendingPrompt
                      key={echo.id}
                      echo={echo}
                      working={phase === "working"}
                      onPutBack={() => putBack(liveKey, echo)}
                    />
                  ))}
              </>
            )}
          </Scroller>
        )}
        {live && !remote ? (
          <div className="flex-none border-t border-hairline bg-app">
            <div className={`${COLUMN} py-3`}>
              <Composer
                draftKey={live.termKey}
                phase={phase}
                gate={gate}
                recordedAt={recordedAt}
                onStopped={reread}
                target={sendTarget}
                shown={shown}
                focusOnShow={pane?.focused ?? true}
                ask={phase === "asking" ? (ask ?? undefined) : undefined}
                dialog={dialogCard}
                lost={lost}
                latestPrompt={latestPrompt}
                journalSeq={lastSeq}
              />
            </div>
          </div>
        ) : !live ? (
          <div className="flex-none border-t border-hairline">
            <p className={`${COLUMN} py-3 text-[11.5px] text-muted-4`}>
              A past session, read from its record.
            </p>
          </div>
        ) : null}
      </div>
    </ConversationScopeContext.Provider>
  );
}

/** The record isn't something to draw: say why, in place. */
function Unavailable({ availability }: { availability: "NoSession" | "NotFound" | "Remote" }) {
  const copy = {
    NoSession: {
      title: "No conversation yet",
      subtitle: "Claude Code hasn't started a session in this tab.",
    },
    // Only once a turn has run (see `turnSeen`): before the first prompt there
    // is no record yet, and that is not a fault.
    NotFound: {
      title: "Nothing recorded",
      subtitle:
        "Claude Code has worked in this session, but santree finds no record of it. Transcript saving may be off for this session.",
    },
    Remote: {
      title: "This session runs on Daedalus",
      subtitle: "Its record is on the home server, which santree doesn't read live yet.",
    },
  }[availability];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3">
      <EmptyState className="flex-none" title={copy.title} subtitle={copy.subtitle} />
    </div>
  );
}

/** The page's shape while its record is read: a prompt and its reply, twice,
 *  in placeholder. */
function ConversationSkeleton() {
  return (
    <div
      role="status"
      aria-label="Reading the conversation…"
      className={`${COLUMN} flex flex-col gap-10 py-6`}
    >
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="h-9 w-[42%] self-end rounded-lg" />
          <Skeleton className="h-2.5 w-[92%]" />
          <Skeleton className="h-2.5 w-[78%]" />
          <Skeleton className="h-2.5 w-[36%]" />
        </div>
      ))}
    </div>
  );
}

/** The reply Claude is drawing, as its hook hands it over line by line:
 *  drawn as the record's prose will be (markdown that loads nothing remote),
 *  marked as still coming. */
function LiveReply({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <Markdown noRemote className={PROSE}>
        {shownText(text)}
      </Markdown>
      <span className="flex items-center gap-1.5 text-[11.5px] text-muted-3">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-green" />
        Writing…
      </span>
    </div>
  );
}

/** A message the session took, until the record shows it. Claude shows a
 *  message it queued only when it gets to it, so the wait is counted only
 *  while it isn't working; past {@link ECHO_LATE_MS} of that, the view says so
 *  and offers the message back. Nothing is sent again. */
function PendingPrompt({
  echo,
  working,
  onPutBack,
}: {
  echo: Echo;
  working: boolean;
  onPutBack: () => void;
}) {
  const late = useHeldFor(!working, ECHO_LATE_MS);
  return (
    <div className="mt-10 flex flex-col items-end gap-1">
      <div className="w-full opacity-60">
        <UserItem
          item={{
            id: `echo-${echo.id}`,
            seq: Number.MAX_SAFE_INTEGER,
            turn: Number.MAX_SAFE_INTEGER,
            atMs: null,
            body: { kind: "user", text: echo.text, images: 0, origin: "Typed" },
          }}
        />
      </div>
      {late ? (
        <div className="flex items-center gap-2 pr-1 text-[11.5px] text-muted-3">
          <span>Claude hasn't shown this yet.</span>
          <button
            type="button"
            onClick={onPutBack}
            className="cursor-pointer font-medium text-fg-2 underline decoration-dotted underline-offset-2"
          >
            Put it back in the composer
          </button>
        </div>
      ) : (
        <span className="pr-1 text-[11px] text-muted-4">
          {echo.queued ? "Queued: Claude reads it when it's done" : "Sent"}
        </span>
      )}
    </div>
  );
}

/** A subagent's own conversation, read the first time it is opened — and, like
 *  the main thread's, only while the view is on screen. */
function SubagentConversation({ agentId, working }: { agentId: string; working: boolean }) {
  const scope = useConversationScope();
  const visible = useSplitPane()?.visible ?? true;
  const { data, error, refetch } = useConversation(scope?.target ?? null, agentId, {
    enabled: visible,
    working,
  });
  if (!data) {
    return error ? (
      <p className="text-[11.5px] text-muted-3">
        Couldn't read its conversation.{" "}
        <button
          type="button"
          onClick={refetch}
          className="cursor-pointer font-medium text-fg-2 underline decoration-dotted underline-offset-2"
        >
          Retry
        </button>
      </p>
    ) : (
      <TerminalActivity label="Reading its conversation…" />
    );
  }
  if (data.availability !== "Ready" || data.items.length === 0) {
    return <p className="text-[11.5px] text-muted-4">Nothing of it is recorded.</p>;
  }
  return <TurnList nested turns={data.turns} working={working} />;
}

/** The target as a value: hosts build it inline, and a new object each render
 *  would re-key everything that reads it. */
function useStableTarget(target: ConversationTarget): ConversationTarget {
  const key =
    target.kind === "tab"
      ? ["tab", target.repo, target.termKey].join("\u0000")
      : ["session", target.repo, target.issueId, target.sessionId].join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the target's identity.
  return useMemo(() => target, [key]);
}

/** Nothing has been acknowledged here: the header names the state as it is. */
const NOT_SEEN = {};

/** The tab's agent as the attention machinery sees it, and its live pane. */
function useLiveAgent(live: LiveTab | undefined) {
  const repo = live?.repo;
  const repos = useMemo(() => (repo ? [repo] : []), [repo]);
  const entries = useAgentEntries(repos, repos);
  const { tabs } = useTerminals();
  const entry = live ? pickEntry(entries ?? [], live) : null;
  const pane = live ? (liveTabFor(live.repo, live.termKey, "Claude", tabs) ?? null) : null;
  const now = useDecayClock(entry ? [entry] : []);
  return { entry, pane, level: entry ? levelOf(entry, NOT_SEEN, now).level : null };
}

/** How long after a Stop the session's row is read again: long enough for
 *  Claude to record the interrupt, if it records one, and well inside the wait
 *  before the composer takes it that it did not (`STOP_REST_MS`). */
const REREAD_AFTER_STOP_MS = 1500;

/**
 * The composer's way to its pane: the gate ({@link sendGate}) over the pane's
 * link, when the claude process the process table sees in that very pane
 * started, and the session's row as the hook stored it — with when that record
 * last said anything, for a Stop to know it was heard — and the same gate on a
 * fresh read, for a send to ask again before its first key and its Enter.
 */
function useSendTarget(live: LiveTab | undefined, paneKey: string | null) {
  const terminals = useTerminals();
  const { tabs, linkOf, paneIdOf, inputFor } = terminals;
  const { data: rows } = useSessionStates();
  const { data: processes } = useAgentProcesses(tabs.length);
  const qc = useQueryClient();
  const repo = live?.repo ?? null;
  const termKey = live?.termKey ?? null;
  const row = repo && termKey ? rowOf(rows, repo, termKey) : null;
  const paneId = paneKey ? paneIdOf(paneKey) : null;
  const floor = termKey ? processFloor(processes, termKey, paneId) : null;

  // The process table is read as panes open — before the seed has exec'd
  // claude — and every 10 s after. While it shows no claude in a live pane, a
  // new record from the session is the cue to look again, so Send opens when
  // Claude reaches its prompt rather than at the next poll.
  const rowAt = row?.updatedAtMs ?? null;
  useEffect(() => {
    if (paneId !== null && floor === null && rowAt !== null) {
      void qc.invalidateQueries({ queryKey: queryKeys.agentProcesses });
    }
  }, [paneId, floor, rowAt, qc]);

  // Claude records an interrupt in its transcript and fires no hook for it, so
  // nothing would push the news; look for it once, soon after the Esc.
  const reread = useCallback(() => {
    window.setTimeout(
      () => void qc.invalidateQueries({ queryKey: queryKeys.sessionStates }),
      REREAD_AFTER_STOP_MS,
    );
  }, [qc]);

  // A send asks again after this render is long gone: it reads the pane's
  // link and id as they are by then.
  const now = useRef(terminals);
  now.current = terminals;
  const sendTarget = useMemo<SendTarget>(
    () => ({
      pane: () => {
        if (!paneKey || floor === null) return null;
        const input = inputFor(paneKey);
        return input ? { input, floor } : null;
      },
      recheck: async (at: SendPane) => {
        if (!repo || !termKey || !paneKey) return "the tab has no terminal.";
        const [freshRows, freshProcesses] = await readSessionNow();
        const terminal = now.current;
        const link = terminal.linkOf(paneKey);
        if (link !== "live") return "the terminal isn't reachable.";
        if (terminal.inputFor(paneKey) !== at.input) return "the terminal was replaced.";
        const freshFloor = processFloor(freshProcesses, termKey, terminal.paneIdOf(paneKey));
        if (freshFloor !== at.floor) return "Claude Code is no longer the process in the terminal.";
        const freshRow = rowOf(freshRows, repo, termKey);
        if (sendGate(link, freshFloor, freshRow, Date.now()).open) return null;
        const closing = freshRow?.prompt;
        if (closing?.callEndedAtMs != null) return "Claude had only just closed a dialog.";
        if (closing?.closedAtMs != null) return "Claude is running what was approved.";
        const recorded = freshRow?.recordedState;
        if (recorded === "permission" || recorded === "waiting") return "Claude opened a dialog.";
        if (recorded === "exited") return "the session ended.";
        return "Claude Code isn't at its prompt.";
      },
      recheckAnswer: async (at: SendPane, dialog: AnsweredDialog) => {
        if (!repo || !termKey || !paneKey) return "the tab has no terminal.";
        const [freshRows, freshProcesses] = await readSessionNow();
        const terminal = now.current;
        if (terminal.linkOf(paneKey) !== "live") return "the terminal isn't reachable.";
        if (terminal.inputFor(paneKey) !== at.input) return "the terminal was replaced.";
        const paneNow = terminal.paneIdOf(paneKey);
        if (processFloor(freshProcesses, termKey, paneNow) !== at.floor) {
          return "Claude Code is no longer the process in the terminal.";
        }
        // The dialog on screen is still the one the card drew: the same
        // session, the same write of the row, the dialog's own state.
        const freshRow = rowOf(freshRows, repo, termKey);
        if (!freshRow || freshRow.sessionId !== dialog.sessionId) return "the session changed.";
        // The stored row still the dialog's write, and what the display reads
        // of the session still that dialog: an approved tool leaves the row as
        // the dialog stored it until its next real change.
        const freshPrompt = freshRow.prompt;
        if (
          !freshPrompt ||
          freshPrompt.recordedAtMs !== dialog.recordedAtMs ||
          freshRow.recordedState !== dialog.recordedState ||
          freshRow.state !== dialog.recordedState
        ) {
          return "Claude has moved past this dialog.";
        }
        // Still open by Claude's own signs, and alone: one recorded behind
        // another may not be the one in front.
        const marked = recordLimit(freshPrompt);
        if (marked.reason !== null) return marked.reason;
        if (freshRow.interruptedAtMs !== null && freshRow.interruptedAtMs > dialog.recordedAtMs) {
          return "the dialog was dismissed.";
        }
        // Before any key of its own: nothing may have reached the pane as the
        // dialog appeared, which may have answered it already.
        if (dialog.first) {
          const state = inputStateOf(paneNow, dialog.recordedAtMs);
          if (state === "seen") return "the terminal had input since this dialog opened.";
          if (state === "unwatched") {
            return "this page wasn't watching the terminal when this dialog appeared.";
          }
        }
        return null;
      },
    }),
    [repo, termKey, paneKey, floor, inputFor],
  );

  const recordedAt = row ? Math.max(row.updatedAtMs ?? 0, row.interruptedAtMs ?? 0) || null : null;
  const gate = useTimedGate(paneKey ? linkOf(paneKey) : null, floor, row);
  return {
    gate,
    recordedAt,
    reread,
    sendTarget,
    row,
    floor,
    paneId,
  };
}

/** {@link sendGate} on this Mac's clock, read again when its answer is due to
 *  change (`changesAt`: a stored dialog's close settling for Stop or Send), so
 *  each opens then, not at whatever render comes next. The reading is never
 *  ahead of the real clock: a late one only keeps them shut a little longer. */
function useTimedGate(
  link: Parameters<typeof sendGate>[0],
  floor: number | null,
  row: RecordedRow | null,
): SendGate {
  const [now, setNow] = useState(() => Date.now());
  const gate = sendGate(link, floor, row, now);
  const at = gate.changesAt;
  useEffect(() => {
    if (at === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [at]);
  return gate;
}

/** What the pane's input says of a dialog recorded at `recordedAtMs`
 *  (`trust.ts` `inputStateOf`), live; `unwatched` while either is unknown. */
function useInputState(paneId: number | null, recordedAtMs: number | null): InputState {
  return useSyncExternalStore(
    subscribeInput,
    () => (recordedAtMs === null ? "unwatched" : inputStateOf(paneId, recordedAtMs)),
    () => "unwatched",
  );
}

/**
 * The dialog the composer gives way to, when the record has its payload and it
 * is the one on screen: the display says Claude asks, the dialog is newer than
 * the claude in the pane (an older one belongs to a process that is gone), and
 * no interrupt came after it (an Esc on a dialog records no hook, only the
 * marker). Null otherwise — the composer's plain card says what is pending.
 *
 * How far the card may answer it is the lowest of what is known (`trust.ts`):
 * whether a claude is seen in the pane; whether Claude's own signs say the
 * dialog closed, or it was recorded behind another; the pane's input around
 * the dialog (a key as it appeared may have answered it); whether the payload
 * was cut; the mode a tool's dialog came up in; and the Claude Code release,
 * against the one the keys were probed on.
 */
function dialogCardOf(
  asking: boolean,
  row: SessionState | null,
  dialog: Dialog | null,
  known: { floor: number | null; input: InputState; cliVersion: string | null },
): DialogCard | null {
  const prompt = row?.prompt ?? null;
  const at = prompt?.recordedAtMs ?? null;
  if (!asking || !row || !prompt || !dialog || at === null) return null;
  if (row.interruptedAtMs !== null && row.interruptedAtMs > at) return null;
  if (known.floor !== null && at <= known.floor) return null;
  const { level, reason } = lowest([
    known.floor === null ? BLOCKED : NO_LIMIT,
    recordLimit(prompt),
    inputLimit(known.input),
    truncatedLimit(prompt.truncated),
    modeLimit(dialog, prompt.permissionMode),
    versionLimit(known.cliVersion),
  ]);
  return { prompt, dialog, sessionId: row.sessionId, recordedAtMs: at, trust: level, why: reason };
}

/** The row the tab's terminal is bound to now: one per tab and provider. */
function rowOf(rows: readonly SessionState[] | undefined, repo: string, termKey: string) {
  return (
    rows?.find((r) => r.repo === repo && r.termKey === termKey && r.agentKind === "Claude") ?? null
  );
}

/** This tab's Claude session; a live one over one that has ended. */
function pickEntry(entries: AgentEntry[], live: LiveTab): AgentEntry | null {
  const mine = entries.filter(
    (e) => e.repo === live.repo && e.termKey === live.termKey && e.agentKind === "Claude",
  );
  return mine.find((e) => e.live && e.state !== "exited") ?? mine[0] ?? null;
}
